/**
 * Notes Browser
 *
 * Handles folder tree rendering, note grid display, new folder/note creation,
 * search with debounce, and tag filtering for the notes browser page.
 */
(function () {
    "use strict";

    // ── State ──────────────────────────────────────────────────────
    let currentFolderId = null;
    let allFolders = [];
    let currentNotes = [];
    let selectedTags = [];
    let searchTimeout = null;

    // ── DOM refs ───────────────────────────────────────────────────
    const folderTree = document.getElementById("folder-tree");
    const notesGrid = document.getElementById("notes-grid");
    const searchInput = document.getElementById("notes-search");
    const btnNewFolder = document.getElementById("btn-new-folder");
    const btnNewDrawing = document.getElementById("btn-new-drawing");
    const btnNewText = document.getElementById("btn-new-text");
    const sidebarToggle = document.getElementById("sidebar-toggle");
    const notesSidebar = document.getElementById("notes-sidebar");
    const sidebarBackdrop = document.getElementById("sidebar-backdrop");
    const sidebarCloseBtn = document.getElementById("sidebar-close-btn");

    if (!notesGrid) return; // not on the notes page

    // ── Mobile sidebar toggle ────────────────────────────────────
    function openSidebar() {
        if (!notesSidebar) return;
        notesSidebar.classList.add("open");
        if (sidebarBackdrop) sidebarBackdrop.classList.add("active");
    }

    function closeSidebar() {
        if (!notesSidebar) return;
        notesSidebar.classList.remove("open");
        if (sidebarBackdrop) sidebarBackdrop.classList.remove("active");
    }

    // ── API helper ─────────────────────────────────────────────────
    async function apiFetch(url, options = {}) {
        const resp = await fetch(url, {
            headers: { "Content-Type": "application/json" },
            ...options,
            body: options.body ? JSON.stringify(options.body) : undefined,
        });
        if (!resp.ok) throw new Error("API error: " + resp.status);
        return resp.json();
    }

    // ── Utility: debounce ──────────────────────────────────────────
    function debounce(fn, ms) {
        let timer = null;
        return function () {
            var args = arguments;
            var ctx = this;
            clearTimeout(timer);
            timer = setTimeout(function () {
                fn.apply(ctx, args);
            }, ms);
        };
    }

    // ── Utility: relative time ─────────────────────────────────────
    function timeAgo(dateStr) {
        if (!dateStr) return "";
        var now = Date.now();
        var then = new Date(dateStr).getTime();
        var diffMs = now - then;
        var diffSec = Math.floor(diffMs / 1000);
        var diffMin = Math.floor(diffSec / 60);
        var diffHr = Math.floor(diffMin / 60);
        var diffDay = Math.floor(diffHr / 24);

        if (diffMin < 1) return "just now";
        if (diffMin < 60) return diffMin + "m ago";
        if (diffHr < 24) return diffHr + "h ago";
        if (diffDay === 1) return "yesterday";
        if (diffDay < 7) return diffDay + "d ago";

        var d = new Date(dateStr);
        var months = [
            "Jan", "Feb", "Mar", "Apr", "May", "Jun",
            "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"
        ];
        return months[d.getMonth()] + " " + d.getDate();
    }

    // ── HTML escape ────────────────────────────────────────────────
    function escapeHtml(str) {
        if (!str) return "";
        return str
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;");
    }

    // ── Folder tree ────────────────────────────────────────────────
    async function fetchFolders() {
        try {
            allFolders = await apiFetch((window.BASE_URL + "/api/notes/folders"));
        } catch (e) {
            console.error("Failed to fetch folders:", e);
            allFolders = [];
        }
        renderFolderTree(allFolders);
    }

    function renderFolderTree(folders) {
        if (!folderTree) return;

        // Group folders by parent_id
        var byParent = {};
        for (var i = 0; i < folders.length; i++) {
            var f = folders[i];
            var pid = f.parent_id || "__root__";
            if (!byParent[pid]) byParent[pid] = [];
            byParent[pid].push(f);
        }

        // Clear and rebuild via DOM methods
        folderTree.textContent = "";

        // Unfiled item at the top
        var unfiledItem = document.createElement("div");
        unfiledItem.className = "folder-item" + (currentFolderId === null ? " active" : "");
        unfiledItem.setAttribute("data-folder-id", "unfiled");

        var unfiledIcon = document.createElement("span");
        unfiledIcon.className = "folder-icon";
        unfiledIcon.textContent = "\uD83D\uDCC1";
        unfiledItem.appendChild(unfiledIcon);

        var unfiledName = document.createElement("span");
        unfiledName.className = "folder-name";
        unfiledName.textContent = "Unfiled";
        unfiledItem.appendChild(unfiledName);

        unfiledItem.addEventListener("click", onFolderClick);
        folderTree.appendChild(unfiledItem);

        // Recursive render
        appendSubtree(folderTree, byParent, "__root__", 0);
    }

    function appendSubtree(container, byParent, parentKey, depth) {
        var children = byParent[parentKey];
        if (!children || children.length === 0) return;

        for (var i = 0; i < children.length; i++) {
            var f = children[i];
            var indent = depth * 16;

            var item = document.createElement("div");
            item.className = "folder-item" + (currentFolderId === f.id ? " active" : "");
            item.setAttribute("data-folder-id", f.id);
            item.style.paddingLeft = (12 + indent) + "px";

            var icon = document.createElement("span");
            icon.className = "folder-icon";
            icon.textContent = "\uD83D\uDCC1";
            item.appendChild(icon);

            var name = document.createElement("span");
            name.className = "folder-name";
            name.textContent = f.name;
            item.appendChild(name);

            if (f.note_count != null) {
                var badge = document.createElement("span");
                badge.className = "folder-badge";
                badge.textContent = f.note_count;
                item.appendChild(badge);
            }

            item.addEventListener("click", onFolderClick);
            container.appendChild(item);

            // Recurse into children
            appendSubtree(container, byParent, f.id, depth + 1);
        }
    }

    function onFolderClick(e) {
        var el = e.currentTarget;
        var folderId = el.getAttribute("data-folder-id");

        if (folderId === "unfiled") {
            currentFolderId = null;
        } else {
            currentFolderId = folderId;
        }

        // Clear search and tags when switching folders
        if (searchInput) searchInput.value = "";
        selectedTags = [];
        clearTagSelection();

        // Update active state
        var items = folderTree.querySelectorAll(".folder-item");
        for (var i = 0; i < items.length; i++) {
            items[i].classList.remove("active");
        }
        el.classList.add("active");

        closeSidebar();
        loadNotesForFolder(currentFolderId);
    }

    // ── Note grid ──────────────────────────────────────────────────
    async function loadNotesForFolder(folderId) {
        try {
            var url = folderId
                ? (window.BASE_URL + "/api/notes/folder/") + folderId
                : (window.BASE_URL + "/api/notes/unfiled");
            currentNotes = await apiFetch(url);
        } catch (e) {
            console.error("Failed to load notes:", e);
            currentNotes = [];
        }
        renderNotesGrid(currentNotes);
    }

    function renderNotesGrid(notes, headerText) {
        if (!notesGrid) return;
        notesGrid.textContent = "";

        if (!notes || notes.length === 0) {
            var emptyDiv = document.createElement("div");
            emptyDiv.className = "notes-empty";
            var emptyP = document.createElement("p");
            emptyP.textContent = headerText ? "No results found" : "No notes in this folder";
            emptyDiv.appendChild(emptyP);
            notesGrid.appendChild(emptyDiv);
            return;
        }

        if (headerText) {
            var headerDiv = document.createElement("div");
            headerDiv.className = "notes-grid-header";
            headerDiv.textContent = headerText;
            notesGrid.appendChild(headerDiv);
        }

        var cardsDiv = document.createElement("div");
        cardsDiv.className = "notes-grid-cards";

        for (var i = 0; i < notes.length; i++) {
            var note = notes[i];

            var card = document.createElement("a");
            card.className = "note-card";
            card.href = (window.BASE_URL + "/notes/") + note.id;

            // Thumbnail
            var thumb = document.createElement("div");
            thumb.className = "note-card-thumbnail";
            if (note.note_type === "text" && note.ocr_text) {
                // Show text preview for text notes
                thumb.classList.add("text-note-thumb");
                thumb.textContent = note.ocr_text.substring(0, 200);
            } else {
                var svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
                svg.setAttribute("viewBox", "0 0 160 120");
                var rect = document.createElementNS("http://www.w3.org/2000/svg", "rect");
                rect.setAttribute("width", "160");
                rect.setAttribute("height", "120");
                rect.setAttribute("fill", "#e5e7eb");
                rect.setAttribute("rx", "4");
                svg.appendChild(rect);
                var svgText = document.createElementNS("http://www.w3.org/2000/svg", "text");
                svgText.setAttribute("x", "80");
                svgText.setAttribute("y", "65");
                svgText.setAttribute("text-anchor", "middle");
                svgText.setAttribute("fill", "#9ca3af");
                svgText.setAttribute("font-size", "14");
                svgText.textContent = note.note_type === "text" ? "Text" : "Note";
                svg.appendChild(svgText);
                thumb.appendChild(svg);
            }
            card.appendChild(thumb);

            // Body
            var body = document.createElement("div");
            body.className = "note-card-body";

            var title = document.createElement("div");
            title.className = "note-card-title";
            title.textContent = note.title || "Untitled";
            body.appendChild(title);

            // Tag chips
            if (note.tags && note.tags.length > 0) {
                var tagsDiv = document.createElement("div");
                tagsDiv.className = "note-card-tags";
                for (var t = 0; t < note.tags.length; t++) {
                    var tagSpan = document.createElement("span");
                    tagSpan.className = "tag-chip-small";
                    tagSpan.textContent = note.tags[t];
                    tagsDiv.appendChild(tagSpan);
                }
                body.appendChild(tagsDiv);
            }

            var timeDiv = document.createElement("div");
            timeDiv.className = "note-card-time";
            timeDiv.textContent = timeAgo(note.updated_at);
            body.appendChild(timeDiv);

            card.appendChild(body);
            cardsDiv.appendChild(card);
        }

        notesGrid.appendChild(cardsDiv);
    }

    // ── New folder ─────────────────────────────────────────────────
    function onNewFolder() {
        var name = prompt("Folder name:");
        if (!name || !name.trim()) return;

        apiFetch((window.BASE_URL + "/api/notes/folders"), {
            method: "POST",
            body: { name: name.trim(), parent_id: currentFolderId },
        })
            .then(function () {
                fetchFolders();
            })
            .catch(function (e) {
                console.error("Failed to create folder:", e);
                alert("Failed to create folder.");
            });
    }

    // ── New note ───────────────────────────────────────────────────
    function createNote(noteType) {
        apiFetch((window.BASE_URL + "/api/notes"), {
            method: "POST",
            body: {
                folder_id: currentFolderId,
                title: "Untitled Note",
                note_type: noteType,
            },
        })
            .then(function (note) {
                window.location.href = (window.BASE_URL + "/notes/") + note.id;
            })
            .catch(function (e) {
                console.error("Failed to create note:", e);
                alert("Failed to create note.");
            });
    }

    // ── Search ─────────────────────────────────────────────────────
    var debouncedSearch = debounce(function (query) {
        if (!query || query.length < 2) {
            loadNotesForFolder(currentFolderId);
            return;
        }
        apiFetch((window.BASE_URL + "/api/notes/search?q=") + encodeURIComponent(query))
            .then(function (results) {
                currentNotes = results;
                renderNotesGrid(results, "Search results");
            })
            .catch(function (e) {
                console.error("Search failed:", e);
            });
    }, 300);

    function onSearchInput(e) {
        var query = e.target.value.trim();
        debouncedSearch(query);
    }

    // ── Tag filtering ──────────────────────────────────────────────
    function onTagChipClick(e) {
        var chip = e.currentTarget;
        var tag = chip.getAttribute("data-tag");
        if (!tag) return;

        chip.classList.toggle("active");

        // Rebuild selectedTags from active chips
        selectedTags = [];
        var chips = document.querySelectorAll(".tag-chip.active");
        for (var i = 0; i < chips.length; i++) {
            selectedTags.push(chips[i].getAttribute("data-tag"));
        }

        applyTagFilter();
        closeSidebar();
    }

    function applyTagFilter() {
        if (selectedTags.length === 0) {
            renderNotesGrid(currentNotes);
            return;
        }

        var filtered = currentNotes.filter(function (note) {
            if (!note.tags || note.tags.length === 0) return false;
            // AND filter: note must have all selected tags
            for (var i = 0; i < selectedTags.length; i++) {
                if (note.tags.indexOf(selectedTags[i]) === -1) return false;
            }
            return true;
        });

        renderNotesGrid(filtered);
    }

    function clearTagSelection() {
        var chips = document.querySelectorAll(".tag-chip.active");
        for (var i = 0; i < chips.length; i++) {
            chips[i].classList.remove("active");
        }
        selectedTags = [];
    }

    // ── Bind tag chips (delegated, since they may be in sidebar) ──
    function bindTagChips() {
        var chips = document.querySelectorAll(".tag-chip[data-tag]");
        for (var i = 0; i < chips.length; i++) {
            chips[i].addEventListener("click", onTagChipClick);
        }
    }

    // ── Init ───────────────────────────────────────────────────────
    function init() {
        // Event listeners
        if (btnNewFolder) btnNewFolder.addEventListener("click", onNewFolder);
        if (btnNewDrawing) btnNewDrawing.addEventListener("click", function () { createNote("whiteboard"); });
        if (btnNewText) btnNewText.addEventListener("click", function () { createNote("text"); });
        if (searchInput) searchInput.addEventListener("input", onSearchInput);
        if (sidebarToggle) sidebarToggle.addEventListener("click", openSidebar);
        if (sidebarCloseBtn) sidebarCloseBtn.addEventListener("click", closeSidebar);
        if (sidebarBackdrop) sidebarBackdrop.addEventListener("click", closeSidebar);

        bindTagChips();

        // Load initial data
        fetchFolders();
        loadNotesForFolder(null);
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }
})();
