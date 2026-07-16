/**
 * Text Note Editor
 *
 * Markdown textarea with live preview, autosave, tag management,
 * and beacon save on tab close.
 */
(function () {
    "use strict";

    var noteData = window.NOTE_DATA;
    if (!noteData) return;

    // Find the first text block
    var textBlock = null;
    if (noteData.blocks) {
        for (var i = 0; i < noteData.blocks.length; i++) {
            if (noteData.blocks[i].block_type === "text") {
                textBlock = noteData.blocks[i];
                break;
            }
        }
    }
    if (!textBlock) {
        console.error("No text block found in note data");
        return;
    }

    // ── DOM refs ─────────────────────────────────────────────────
    var textarea = document.getElementById("text-editor-textarea");
    var preview = document.getElementById("text-editor-preview");
    var titleInput = document.getElementById("note-title");
    var saveStatus = document.getElementById("save-status");
    var tabs = document.querySelectorAll(".editor-tab");
    var tagChips = document.getElementById("tag-chips");
    var btnAddTag = document.getElementById("btn-add-tag");
    var btnMoveNote = document.getElementById("btn-move-note");
    var btnDeleteNote = document.getElementById("btn-delete-note");
    var ttsPaneEl = document.getElementById("note-tts-pane");
    var ttsContentEl = document.getElementById("note-tts-content");
    var audioBarEl = document.getElementById("note-tts-audio-bar");

    // ── State ────────────────────────────────────────────────────
    var saveTimer = null;
    var titleTimer = null;
    var currentTab = "edit";
    var lastSavedMarkdown = "";

    // ── Init content ─────────────────────────────────────────────
    var markdown = (textBlock.content && textBlock.content.markdown) || "";
    textarea.value = markdown;
    lastSavedMarkdown = markdown;

    // ── Markdown rendering helper ────────────────────────────────
    // Uses marked.js (loaded in base.html). Content is user-authored
    // markdown from their own notes in a single-user local app.
    function renderMarkdown(md) {
        if (typeof marked !== "undefined" && marked.parse) {
            return marked.parse(md);
        }
        // Fallback: escape and convert newlines
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

    // ── Autosave block content ───────────────────────────────────
    function saveBlockContent() {
        var md = textarea.value;
        if (md === lastSavedMarkdown) return;

        setSaveStatus("Saving...");

        var html = renderMarkdown(md);

        fetch((window.BASE_URL + "/api/notes/blocks/") + textBlock.id, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                content: { markdown: md, html: html }
            }),
        })
            .then(function (resp) {
                if (!resp.ok) throw new Error("Save failed: " + resp.status);
                lastSavedMarkdown = md;
                setSaveStatus("Saved");
            })
            .catch(function (e) {
                console.error("Save error:", e);
                setSaveStatus("Error");
            });
    }

    function debouncedSave() {
        clearTimeout(saveTimer);
        setSaveStatus("Editing...");
        saveTimer = setTimeout(saveBlockContent, 1500);
    }

    textarea.addEventListener("input", debouncedSave);

    // ── Tab switching ────────────────────────────────────────────
    function switchTab(tab) {
        // Leaving listen tab: destroy TTS player
        if (currentTab === "listen" && tab !== "listen") {
            if (window.NoteTTS) window.NoteTTS.destroy();
            if (ttsPaneEl) ttsPaneEl.style.display = "none";
        }

        currentTab = tab;
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
            if (ttsPaneEl) ttsPaneEl.style.display = "none";
            // Render markdown preview using marked.js (user-authored content in single-user local app)
            preview.innerHTML = renderMarkdown(textarea.value);  // nosec: user-authored markdown
        } else if (tab === "listen") {
            textarea.style.display = "none";
            preview.style.display = "none";

            var md = textarea.value.trim();
            if (!md) {
                if (ttsPaneEl) ttsPaneEl.style.display = "";
                ttsContentEl.textContent = "Nothing to listen to.";
                return;
            }

            if (ttsPaneEl) ttsPaneEl.style.display = "";
            ttsContentEl.textContent = "Preparing audio...";

            fetch((window.BASE_URL + "/api/notes/tts/prepare"), {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ markdown: md }),
            })
                .then(function (resp) { return resp.json(); })
                .then(function (data) {
                    if (!data.paragraphs || data.paragraphs.length === 0) {
                        ttsContentEl.textContent = "Nothing to listen to.";
                        return;
                    }
                    ttsContentEl.textContent = "";
                    if (window.NoteTTS) {
                        window.NoteTTS.init({
                            paragraphs: data.paragraphs,
                            cacheKey: data.cache_key,
                            containerEl: ttsContentEl,
                            ttsPane: ttsPaneEl,
                        });
                    }
                })
                .catch(function (e) {
                    console.error("TTS prepare error:", e);
                    ttsContentEl.textContent = "Failed to prepare audio.";
                });
        }
    }

    for (var i = 0; i < tabs.length; i++) {
        tabs[i].addEventListener("click", function (e) {
            switchTab(e.currentTarget.getAttribute("data-tab"));
        });
    }

    // ── Title autosave ───────────────────────────────────────────
    function saveTitle() {
        var title = titleInput.value.trim();
        if (!title) return;

        fetch((window.BASE_URL + "/api/notes/") + noteData.id, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title: title }),
        }).catch(function (e) {
            console.error("Title save error:", e);
        });
    }

    titleInput.addEventListener("input", function () {
        clearTimeout(titleTimer);
        titleTimer = setTimeout(saveTitle, 1500);
    });

    // ── Tag management ───────────────────────────────────────────
    function addTag(name) {
        fetch((window.BASE_URL + "/api/notes/") + noteData.id + "/tags/" + encodeURIComponent(name), {
            method: "POST",
        })
            .then(function (resp) {
                if (!resp.ok) throw new Error("Tag add failed");
                var chip = document.createElement("span");
                chip.className = "tag-chip removable";
                chip.setAttribute("data-tag", name);
                chip.textContent = name + " ";
                var removeBtn = document.createElement("button");
                removeBtn.className = "tag-remove";
                removeBtn.textContent = "\u00d7";
                removeBtn.addEventListener("click", function () {
                    removeTag(name, chip);
                });
                chip.appendChild(removeBtn);
                tagChips.insertBefore(chip, btnAddTag);
            })
            .catch(function (e) {
                console.error("Tag add error:", e);
            });
    }

    function removeTag(name, chipEl) {
        fetch((window.BASE_URL + "/api/notes/") + noteData.id + "/tags/" + encodeURIComponent(name), {
            method: "DELETE",
        })
            .then(function (resp) {
                if (!resp.ok) throw new Error("Tag remove failed");
                chipEl.remove();
            })
            .catch(function (e) {
                console.error("Tag remove error:", e);
            });
    }

    if (btnAddTag) {
        btnAddTag.addEventListener("click", function () {
            var name = prompt("Tag name:");
            if (name && name.trim()) addTag(name.trim().toLowerCase());
        });
    }

    // Bind existing tag remove buttons
    var existingRemoveBtns = tagChips.querySelectorAll(".tag-remove");
    for (var r = 0; r < existingRemoveBtns.length; r++) {
        (function (btn) {
            var chip = btn.parentElement;
            var tagName = chip.getAttribute("data-tag");
            btn.addEventListener("click", function () {
                removeTag(tagName, chip);
            });
        })(existingRemoveBtns[r]);
    }

    // ── Move note ────────────────────────────────────────────────
    if (btnMoveNote) {
        btnMoveNote.addEventListener("click", function (e) {
            e.preventDefault();
            fetch((window.BASE_URL + "/api/notes/folders"))
                .then(function (resp) { return resp.json(); })
                .then(function (folders) {
                    var options = ["Unfiled"];
                    var ids = [null];
                    for (var f = 0; f < folders.length; f++) {
                        options.push(folders[f].name);
                        ids.push(folders[f].id);
                    }
                    var choice = prompt(
                        "Move to folder:\n" +
                        options.map(function (o, i) { return i + ": " + o; }).join("\n") +
                        "\n\nEnter number:"
                    );
                    if (choice === null) return;
                    var idx = parseInt(choice, 10);
                    if (isNaN(idx) || idx < 0 || idx >= ids.length) return;

                    return fetch((window.BASE_URL + "/api/notes/") + noteData.id, {
                        method: "PATCH",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({ folder_id: ids[idx] }),
                    });
                })
                .catch(function (e) {
                    console.error("Move failed:", e);
                });
        });
    }

    // ── Delete note ──────────────────────────────────────────────
    if (btnDeleteNote) {
        btnDeleteNote.addEventListener("click", function (e) {
            e.preventDefault();
            if (!confirm("Delete this note?")) return;
            fetch((window.BASE_URL + "/api/notes/") + noteData.id, { method: "DELETE" })
                .then(function () {
                    window.location.href = "/notes";
                })
                .catch(function (e) {
                    console.error("Delete failed:", e);
                });
        });
    }

    // ── Beacon save on tab close ─────────────────────────────────
    function beaconSave() {
        var md = textarea.value;
        if (md === lastSavedMarkdown) return;

        var html = renderMarkdown(md);

        var payload = JSON.stringify({
            blocks: [
                { id: textBlock.id, content: { markdown: md, html: html } }
            ]
        });

        navigator.sendBeacon(
            (window.BASE_URL + "/api/notes/") + noteData.id + "/beacon-save",
            new Blob([payload], { type: "application/json" })
        );
    }

    document.addEventListener("visibilitychange", function () {
        if (document.visibilityState === "hidden") beaconSave();
    });

    window.addEventListener("beforeunload", beaconSave);

    // ── Keyboard shortcuts ───────────────────────────────────────
    textarea.addEventListener("keydown", function (e) {
        // Ctrl+S / Cmd+S to force save
        if ((e.ctrlKey || e.metaKey) && e.key === "s") {
            e.preventDefault();
            clearTimeout(saveTimer);
            saveBlockContent();
        }
        // Tab to indent
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
