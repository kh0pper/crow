/**
 * PM Workspace — markdown note editor.
 *
 * Ported from canvas-companion's text editor: markdown textarea with
 * preview tab, debounced autosave, tag chips, beacon save on tab close.
 *
 * PM Workspace changes: whole-note saves POST to PM_BASE + /api/pm/notes
 * as a text/plain JSON string {id, title, kind:'markdown', content_md,
 * tags}; tags are client-side chips submitted with each save.
 */
(function () {
    "use strict";

    var noteData = window.NOTE_DATA;
    if (!noteData) return;

    var PM_BASE = window.PM_BASE || "";

    // ── DOM refs ─────────────────────────────────────────────────
    var textarea = document.getElementById("text-editor-textarea");
    var preview = document.getElementById("text-editor-preview");
    var titleInput = document.getElementById("note-title");
    var saveStatus = document.getElementById("save-status");
    var tabs = document.querySelectorAll(".editor-tab");
    var tagChips = document.getElementById("tag-chips");
    var btnAddTag = document.getElementById("btn-add-tag");

    // ── State ────────────────────────────────────────────────────
    var noteId = noteData.id || null;
    var tags = (noteData.tags || []).slice();
    var saveTimer = null;
    var saving = false;
    var lastSaved = null;

    // ── Init content ─────────────────────────────────────────────
    textarea.value = noteData.content_md || "";
    titleInput.value = noteData.title || "";
    lastSaved = snapshot();
    renderTagChips();

    function snapshot() {
        return JSON.stringify([textarea.value, titleInput.value, tags.join(",")]);
    }

    // ── Markdown rendering helper ────────────────────────────────
    // Uses marked.js when loaded; falls back to escaped text.
    function renderMarkdown(md) {
        if (typeof marked !== "undefined" && marked.parse) {
            return marked.parse(md);
        }
        return md.replace(/&/g, "&amp;").replace(/</g, "&lt;")
            .replace(/>/g, "&gt;").replace(/\n/g, "<br>");
    }

    // ── Save status helper ───────────────────────────────────────
    function setSaveStatus(status) {
        saveStatus.textContent = status;
        saveStatus.className = "save-status";
        if (status === "Saved") saveStatus.classList.add("saved");
        else if (status === "Saving...") saveStatus.classList.add("saving");
        else if (status === "Error") saveStatus.classList.add("error");
    }

    // ── Autosave ─────────────────────────────────────────────────
    function payload() {
        return {
            id: noteId,
            title: titleInput.value.trim() || "Untitled",
            kind: "markdown",
            content_md: textarea.value,
            tags: tags.join(","),
        };
    }

    function saveNote() {
        if (snapshot() === lastSaved || saving) return;
        saving = true;
        setSaveStatus("Saving...");
        var snap = snapshot();

        fetch(PM_BASE + "/api/pm/notes", {
            method: "POST",
            headers: { "Content-Type": "text/plain;charset=UTF-8" },
            body: JSON.stringify(payload()),
        })
            .then(function (resp) {
                if (!resp.ok) throw new Error("Save failed: " + resp.status);
                return resp.json();
            })
            .then(function (data) {
                if (!noteId && data.note && data.note.id) {
                    noteId = data.note.id;
                    try { history.replaceState(null, "", PM_BASE + "/pm/notes/" + noteId + "/edit"); } catch (e) { /* ok */ }
                }
                lastSaved = snap;
                setSaveStatus("Saved");
            })
            .catch(function (e) {
                console.error("Save error:", e);
                setSaveStatus("Error");
            })
            .finally(function () { saving = false; });
    }

    function debouncedSave() {
        clearTimeout(saveTimer);
        setSaveStatus("Editing...");
        saveTimer = setTimeout(saveNote, 1500);
    }

    textarea.addEventListener("input", debouncedSave);
    titleInput.addEventListener("input", debouncedSave);

    // ── Tab switching ────────────────────────────────────────────
    function switchTab(tab) {
        for (var i = 0; i < tabs.length; i++) {
            tabs[i].classList.toggle("active", tabs[i].getAttribute("data-tab") === tab);
        }
        if (tab === "edit") {
            textarea.style.display = "";
            preview.style.display = "none";
            textarea.focus();
        } else if (tab === "preview") {
            textarea.style.display = "none";
            preview.style.display = "";
            // User-authored markdown from their own notes.
            preview.innerHTML = renderMarkdown(textarea.value);
        }
    }

    for (var i = 0; i < tabs.length; i++) {
        tabs[i].addEventListener("click", function (e) {
            switchTab(e.currentTarget.getAttribute("data-tab"));
        });
    }

    // ── Tag management (client-side, saved with the note) ────────
    function renderTagChips() {
        var chips = tagChips.querySelectorAll(".tag-chip");
        for (var c = 0; c < chips.length; c++) chips[c].remove();
        tags.forEach(function (tag) {
            var chip = document.createElement("span");
            chip.className = "tag-chip removable";
            chip.setAttribute("data-tag", tag);
            chip.appendChild(document.createTextNode(tag + " "));
            var removeBtn = document.createElement("button");
            removeBtn.className = "tag-remove";
            removeBtn.type = "button";
            removeBtn.textContent = "×";
            removeBtn.addEventListener("click", function () {
                tags = tags.filter(function (t) { return t !== tag; });
                renderTagChips();
                debouncedSave();
            });
            chip.appendChild(removeBtn);
            tagChips.insertBefore(chip, btnAddTag);
        });
    }

    if (btnAddTag) {
        btnAddTag.addEventListener("click", function () {
            var name = prompt("Tag name:");
            if (name && name.trim()) {
                tags.push(name.trim().toLowerCase());
                renderTagChips();
                debouncedSave();
            }
        });
    }

    // ── Beacon save on tab close ─────────────────────────────────
    function beaconSave() {
        if (snapshot() === lastSaved) return;
        var body = JSON.stringify(payload());
        navigator.sendBeacon(
            PM_BASE + "/api/pm/notes",
            new Blob([body], { type: "text/plain;charset=UTF-8" })
        );
        lastSaved = snapshot();
    }

    document.addEventListener("visibilitychange", function () {
        if (document.visibilityState === "hidden") beaconSave();
    });

    window.addEventListener("beforeunload", beaconSave);

    // ── Keyboard shortcuts ───────────────────────────────────────
    textarea.addEventListener("keydown", function (e) {
        if ((e.ctrlKey || e.metaKey) && e.key === "s") {
            e.preventDefault();
            clearTimeout(saveTimer);
            saveNote();
        }
        if (e.key === "Tab") {
            e.preventDefault();
            var start = textarea.selectionStart;
            var end = textarea.selectionEnd;
            textarea.value = textarea.value.substring(0, start) + "    " + textarea.value.substring(end);
            textarea.selectionStart = textarea.selectionEnd = start + 4;
            debouncedSave();
        }
    });
})();
