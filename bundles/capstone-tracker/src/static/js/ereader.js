/**
 * E-Reader Audio Player
 *
 * Manages paragraph-by-paragraph TTS playback with word-level highlighting,
 * auto-scroll, bookmarking, and Media Session integration.
 */
(function () {
  "use strict";

  // ── Parse page data ────────────────────────────────────────────
  var dataEl = document.getElementById("er-data");
  if (!dataEl) return;
  var DATA = JSON.parse(dataEl.textContent);

  // ── State ──────────────────────────────────────────────────────
  var audio = new Audio();
  var state = {
    playing: false,
    currentPara: 0,
    paragraphs: DATA.paragraphs || [],
    cacheKey: DATA.cacheKey,
    totalParagraphs: DATA.totalParagraphs,
    timing: {}, // para index -> timing array
    timingMap: {}, // para index -> timing-index-to-span-index map
    audioUrls: {}, // para index -> url
    generating: {}, // para index -> promise
    skipFailures: 0, // consecutive paragraph failures
    speed: 1.0,
    voice: "en-US-BrianNeural",
    rafId: null,
    bookmarkInterval: null,
    hasSetLastOpened: false, // track if we've updated ereader-last-opened this session
  };

  // ── DOM refs ───────────────────────────────────────────────────
  var playBtn = document.getElementById("er-play");
  var prevBtn = document.getElementById("er-prev");
  var nextBtn = document.getElementById("er-next");
  var speedBtn = document.getElementById("er-speed");
  var voiceSelect = document.getElementById("er-voice");
  var progressBar = document.getElementById("er-progress-bar");
  var progressFill = document.getElementById("er-progress-fill");
  var timeCurrent = document.getElementById("er-time-current");
  var timeTotal = document.getElementById("er-time-total");
  var paraIndicator = document.getElementById("er-para-indicator");
  var readingPane = document.getElementById("er-reading-pane");
  var contentEl = document.getElementById("er-content");

  // ── Word wrapping ──────────────────────────────────────────────
  // Wrap each word in each paragraph with a <span> using safe DOM methods.
  // Table paragraphs ([TABLE] prefix) are rendered as HTML tables instead.
  var paraEls = contentEl.querySelectorAll(".er-para");
  paraEls.forEach(function (el) {
    var idx = parseInt(el.dataset.para, 10);
    var rawText = state.paragraphs[idx] || "";

    // Image paragraph: render as <img>
    if (rawText.indexOf("[IMAGE]") === 0) {
      try {
        var meta = JSON.parse(rawText.substring("[IMAGE]".length));
        el.classList.add("er-image");
        var wrapper = document.createElement("div");
        wrapper.className = "er-image-content";
        var img = document.createElement("img");
        // Prepend gateway proxy prefix so /static/... URLs from the bundle
        // resolve via the proxy, not the host root. window.BASE_URL is set
        // by base.html from FastAPI's root_path.
        img.src = (window.BASE_URL || "") + meta.url;
        img.alt = meta.alt || "Figure";
        img.loading = "lazy";
        wrapper.appendChild(img);
        while (el.firstChild) el.removeChild(el.firstChild);
        el.appendChild(wrapper);
      } catch(e) { /* fallback: show as text */ }
      return;
    }

    // Table paragraph: render as HTML table via marked.js
    // Content is from our own PDF extraction pipeline (trusted, server-generated)
    if (rawText.indexOf("[TABLE]\n") === 0) {
      var tableMd = rawText.substring("[TABLE]\n".length);
      // Clean <br> tags that may come from PDF extraction
      tableMd = tableMd.replace(/<br>/g, " ");
      el.classList.add("er-table");
      var wrapper = document.createElement("div");
      wrapper.className = "er-table-content";
      // marked.parse on server-generated table markdown (same trust model as note-text-editor)
      wrapper.innerHTML = marked.parse(tableMd);  // nosec: trusted extraction pipeline content
      // Clear and replace content
      while (el.firstChild) {
        el.removeChild(el.firstChild);
      }
      el.appendChild(wrapper);
      return; // Skip word wrapping for tables
    }

    var text = el.textContent;
    var words = text.split(/(\s+)/);

    // Clear existing content safely
    while (el.firstChild) {
      el.removeChild(el.firstChild);
    }

    var wi = 0;
    words.forEach(function (w) {
      if (/^\s+$/.test(w)) {
        el.appendChild(document.createTextNode(w));
      } else if (w) {
        var span = document.createElement("span");
        span.className = "word";
        span.dataset.wi = wi;
        span.textContent = w;
        el.appendChild(span);
        wi++;
      }
    });
  });

  // ── Multi-word timing expansion ────────────────────────────────
  // Edge TTS occasionally combines words into a single timing entry
  // (e.g., "in 2021"). Split these into separate entries with
  // interpolated offsets so each word maps to its own span.
  function expandMultiWordTimings(timing) {
    var result = [];
    for (var i = 0; i < timing.length; i++) {
      var entry = timing[i];
      var words = (entry.text || "").split(/\s+/).filter(function (w) {
        return w;
      });
      if (words.length <= 1) {
        result.push(entry);
        continue;
      }
      var perWord = entry.duration_ms / words.length;
      for (var j = 0; j < words.length; j++) {
        result.push({
          text: words[j],
          offset_ms: entry.offset_ms + j * perWord,
          duration_ms: perWord,
        });
      }
    }
    return result;
  }

  // ── Timing map (text-matching instead of index-based) ──────────
  function normalizeWord(w) {
    // Strip punctuation and lowercase for fuzzy matching
    return w.replace(/[^\w]/g, "").toLowerCase();
  }

  function buildTimingMap(paraIndex) {
    var timing = state.timing[paraIndex];
    if (!timing || !timing.length) return;

    var paraEl = paraEls[paraIndex];
    if (!paraEl) return;

    var wordSpans = paraEl.querySelectorAll(".word");
    if (!wordSpans.length) return;

    var map = {}; // timing index -> span index
    var spanIdx = 0;

    for (var ti = 0; ti < timing.length; ti++) {
      var tWord = normalizeWord(timing[ti].text || "");
      if (!tWord) {
        // No text in timing entry, map to current span
        map[ti] = Math.min(spanIdx, wordSpans.length - 1);
        continue;
      }

      // Try to match this timing word to the current or nearby span
      var bestSpan = spanIdx;
      var bestScore = 0;

      // Search within a small window around current position
      var searchStart = Math.max(0, spanIdx - 1);
      var searchEnd = Math.min(wordSpans.length - 1, spanIdx + 3);

      for (var si = searchStart; si <= searchEnd; si++) {
        var sWord = normalizeWord(wordSpans[si].textContent);
        if (sWord === tWord) {
          // Exact match
          bestSpan = si;
          bestScore = 2;
          break;
        }
        // Partial match: timing word is contained in span word (e.g. TTS
        // splits "self-study" into "self" and "study")
        if (sWord.indexOf(tWord) >= 0 || tWord.indexOf(sWord) >= 0) {
          if (bestScore < 1) {
            bestSpan = si;
            bestScore = 1;
          }
        }
      }

      map[ti] = bestSpan;

      // Advance spanIdx only if we matched at or beyond current position
      if (bestSpan >= spanIdx && bestScore >= 1) {
        // For partial matches (TTS splits one display word into multiple
        // spoken words), don't advance past the span — next timing entry
        // may also map to the same span.
        // Only advance if we had an exact match and the next timing entry
        // is likely a different word.
        if (bestScore === 2) {
          spanIdx = bestSpan + 1;
        }
        // For partial matches, keep spanIdx pointing at this span
      }
    }

    state.timingMap[paraIndex] = map;
  }

  // ── TTS generation ─────────────────────────────────────────────
  function getRateString() {
    // Convert speed multiplier to edge-tts rate string
    var pct = Math.round((state.speed - 1) * 100);
    return (pct >= 0 ? "+" : "") + pct + "%";
  }

  function generateTTS(start, end) {
    // Generate TTS for paragraph range, return promise
    var key =
      start + "-" + end + "-" + state.voice + "-" + getRateString();
    if (state.generating[key]) return state.generating[key];

    var controller = new AbortController();
    var fetchTimeout = setTimeout(function () {
      controller.abort();
    }, 30000);

    var promise = fetch("/api/ereader/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        paragraphs: state.paragraphs,
        cache_key: state.cacheKey,
        start: start,
        end: end,
        voice: state.voice,
        rate: getRateString(),
      }),
    })
      .then(function (r) {
        clearTimeout(fetchTimeout);
        return r.json();
      })
      .then(function (data) {
        if (data.results) {
          data.results.forEach(function (r) {
            if (r.success) {
              state.audioUrls[r.para_index] = r.audio_url;
              state.timing[r.para_index] = expandMultiWordTimings(r.timing);
              buildTimingMap(r.para_index);
            }
          });
        }
        delete state.generating[key];
        return data;
      })
      .catch(function (err) {
        clearTimeout(fetchTimeout);
        delete state.generating[key];
        console.error("TTS generation failed:", err);
      });

    state.generating[key] = promise;
    return promise;
  }

  function ensureParaReady(idx) {
    if (state.audioUrls[idx]) return Promise.resolve();
    return generateTTS(idx, idx + 1);
  }

  function lookAhead() {
    // Pre-generate next few paragraphs
    var start = state.currentPara + 1;
    var end = Math.min(start + 3, state.totalParagraphs);
    if (start < end) {
      generateTTS(start, end);
    }
  }

  // ── Playback ───────────────────────────────────────────────────
  function playParagraph(idx) {
    if (idx < 0 || idx >= state.totalParagraphs) {
      stop();
      return;
    }

    // Update last-opened when user actively engages with content (first play)
    if (!state.hasSetLastOpened) {
      localStorage.setItem("ereader-last-opened", getBookmarkKey());
      state.hasSetLastOpened = true;
    }

    state.currentPara = idx;
    updateParaHighlight();
    updateParaIndicator();

    ensureParaReady(idx).then(function () {
      var url = state.audioUrls[idx];
      if (!url) {
        console.error("No audio URL for paragraph", idx);
        state.skipFailures = (state.skipFailures || 0) + 1;
        if (state.skipFailures >= 3) {
          console.error("Too many consecutive failures, stopping playback");
          stop();
          return;
        }
        playParagraph(idx + 1);
        return;
      }
      state.skipFailures = 0;

      // Prepend gateway proxy prefix; same rationale as img.src above.
      audio.src = (window.BASE_URL || "") + url;
      audio.playbackRate = state.speed;
      audio
        .play()
        .then(function () {
          state.playing = true;
          if (state._resumeAudioTime) {
            audio.currentTime = state._resumeAudioTime;
            state._resumeAudioTime = null;
          }
          updatePlayButton();
          startHighlightLoop();
          lookAhead();
          updateMediaSession();
        })
        .catch(function (err) {
          console.error("Audio play failed:", err);
          state.playing = false;
          updatePlayButton();
          stopHighlightLoop();
        });
    });
  }

  function togglePlay() {
    if (state.playing) {
      pause();
    } else {
      if (audio.src && audio.paused && audio.currentTime > 0) {
        // Resume
        audio.play().then(function() {
          state.playing = true;
          updatePlayButton();
          startHighlightLoop();
        });
      } else {
        playParagraph(state.currentPara);
      }
    }
  }

  function pause() {
    audio.pause();
    state.playing = false;
    updatePlayButton();
    stopHighlightLoop();
    saveBookmark();
  }

  function stop() {
    audio.pause();
    audio.currentTime = 0;
    state.playing = false;
    updatePlayButton();
    stopHighlightLoop();
    clearWordHighlight();
    saveBookmark();
  }

  function skipNext() {
    var next = state.currentPara + 1;
    if (next < state.totalParagraphs) {
      clearWordHighlight();
      playParagraph(next);
    }
  }

  function skipPrev() {
    // If more than 2s in, restart current; otherwise go back
    if (audio.currentTime > 2) {
      audio.currentTime = 0;
    } else {
      var prev = state.currentPara - 1;
      if (prev >= 0) {
        clearWordHighlight();
        playParagraph(prev);
      }
    }
  }

  // Audio ended -> next paragraph
  audio.addEventListener("ended", function () {
    clearWordHighlight();
    var next = state.currentPara + 1;
    if (next < state.totalParagraphs) {
      playParagraph(next);
    } else {
      stop();
    }
  });

  // Audio error -> skip to next paragraph
  audio.addEventListener("error", function () {
    console.error("Audio error for para", state.currentPara, audio.error);
    state.skipFailures = (state.skipFailures || 0) + 1;
    if (state.skipFailures >= 3) {
      console.error("Too many consecutive audio errors, stopping playback");
      stop();
      return;
    }
    var next = state.currentPara + 1;
    if (next < state.totalParagraphs) {
      clearWordHighlight();
      playParagraph(next);
    } else {
      stop();
    }
  });

  // ── Word highlighting (requestAnimationFrame) ──────────────────
  var lastActiveWord = null;

  function startHighlightLoop() {
    if (state.rafId) return;
    function loop() {
      highlightCurrentWord();
      state.rafId = requestAnimationFrame(loop);
    }
    state.rafId = requestAnimationFrame(loop);
  }

  function stopHighlightLoop() {
    if (state.rafId) {
      cancelAnimationFrame(state.rafId);
      state.rafId = null;
    }
  }

  function highlightCurrentWord() {
    var timing = state.timing[state.currentPara];
    if (!timing || !timing.length) return;

    // Perceptual delay: highlight lags audio by 150ms so the
    // highlighted word matches what the listener is currently hearing,
    // not the word about to start.
    var HIGHLIGHT_DELAY_MS = 150;
    var currentMs = Math.max(0, audio.currentTime * 1000 - HIGHLIGHT_DELAY_MS);

    // Binary search for current word
    var lo = 0,
      hi = timing.length - 1,
      best = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (timing[mid].offset_ms <= currentMs) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }

    if (best < 0) return;

    var paraEl = paraEls[state.currentPara];
    if (!paraEl) return;

    var wordSpans = paraEl.querySelectorAll(".word");

    // Use timing map for text-matched lookup instead of 1:1 index
    var map = state.timingMap[state.currentPara];
    var spanIdx = map ? (map[best] !== undefined ? map[best] : best) : best;
    if (spanIdx >= wordSpans.length) spanIdx = wordSpans.length - 1;

    var targetSpan = wordSpans[spanIdx];
    if (targetSpan === lastActiveWord) return;

    // Remove old highlight
    if (lastActiveWord) {
      lastActiveWord.classList.remove("active");
    }

    // Add new highlight
    targetSpan.classList.add("active");
    lastActiveWord = targetSpan;

    // Auto-scroll
    autoScrollToWord(targetSpan);

    // Update progress
    updateProgress();
  }

  function clearWordHighlight() {
    if (lastActiveWord) {
      lastActiveWord.classList.remove("active");
      lastActiveWord = null;
    }
  }

  // ── Auto-scroll ────────────────────────────────────────────────
  function autoScrollToWord(span) {
    if (!readingPane || !span) return;

    var paneRect = readingPane.getBoundingClientRect();
    var spanRect = span.getBoundingClientRect();

    // Check if word is in the center 40% of the pane
    var paneTop = paneRect.top;
    var paneBottom = paneRect.bottom;
    var paneHeight = paneBottom - paneTop;
    var centerTop = paneTop + paneHeight * 0.3;
    var centerBottom = paneTop + paneHeight * 0.7;

    if (spanRect.top < centerTop || spanRect.bottom > centerBottom) {
      // Scroll to center the word
      var targetScroll =
        readingPane.scrollTop +
        (spanRect.top - paneTop) -
        paneHeight * 0.4;
      readingPane.scrollTo({
        top: targetScroll,
        behavior: "smooth",
      });
    }
  }

  // ── Paragraph highlighting ─────────────────────────────────────
  function updateParaHighlight() {
    paraEls.forEach(function (el, i) {
      el.classList.toggle("playing", i === state.currentPara);
    });
  }

  // ── UI updates ─────────────────────────────────────────────────
  function updatePlayButton() {
    // Use text content instead of HTML entities for safety
    playBtn.textContent = state.playing ? "\u23F8" : "\u25B6";
  }

  function updateParaIndicator() {
    paraIndicator.textContent =
      "Para " + (state.currentPara + 1) + " / " + state.totalParagraphs;
  }

  function updateProgress() {
    if (!audio.duration || isNaN(audio.duration)) return;
    var pct = (audio.currentTime / audio.duration) * 100;
    progressFill.style.width = pct + "%";
    timeCurrent.textContent = formatTime(audio.currentTime);
    timeTotal.textContent = formatTime(audio.duration);
  }

  function formatTime(s) {
    var m = Math.floor(s / 60);
    var sec = Math.floor(s % 60);
    return m + ":" + (sec < 10 ? "0" : "") + sec;
  }

  // ── Speed control ──────────────────────────────────────────────
  var speeds = [0.5, 0.75, 1.0, 1.25, 1.5, 1.75, 2.0];
  var speedIdx = 2; // 1.0x

  function cycleSpeed() {
    speedIdx = (speedIdx + 1) % speeds.length;
    state.speed = speeds[speedIdx];
    audio.playbackRate = state.speed;
    speedBtn.textContent = state.speed + "x";
  }

  // ── Voice control ──────────────────────────────────────────────
  function changeVoice() {
    var newVoice = voiceSelect.value;
    if (newVoice === state.voice) return;
    state.voice = newVoice;
    // Clear cached audio (timing depends on voice)
    state.audioUrls = {};
    state.timing = {};
    state.generating = {};
    // If playing, regenerate current paragraph
    if (state.playing) {
      var idx = state.currentPara;
      pause();
      playParagraph(idx);
    }
  }

  // ── Progress bar click ─────────────────────────────────────────
  function seekProgress(e) {
    if (!audio.duration) return;
    var rect = progressBar.getBoundingClientRect();
    var pct = (e.clientX - rect.left) / rect.width;
    audio.currentTime = pct * audio.duration;
  }

  // ── Bookmarking ────────────────────────────────────────────────
  function getBookmarkKey() {
    if (DATA.contentType === "textbook") {
      return "ereader-bookmark-textbook-" + DATA.shortTitle;
    } else if (DATA.contentType === "document") {
      return "ereader-bookmark-document-" + DATA.shortTitle;
    } else {
      return "ereader-bookmark-source-" + DATA.sourceId;
    }
  }

  function saveBookmark() {
    // Guard: don't overwrite a meaningful bookmark with a "start" position.
    // This prevents accidental overwrites from stale cached JS or
    // any code path that calls saveBookmark before playback begins.
    if (state.currentPara === 0 && (!audio.currentTime || audio.currentTime < 1) && !state.playing) {
      return;
    }

    var bm = {
      type: DATA.contentType,
      para: state.currentPara,
      audioTime: audio.currentTime || 0,
      voice: state.voice,
      rate: state.speed,
      savedAt: Date.now(),
    };

    if (DATA.contentType === "textbook") {
      bm.shortTitle = DATA.shortTitle;
      bm.chapter = DATA.chapterNum;
      bm.bookTitle = DATA.bookTitle;
      bm.chapterTitle = DATA.chapterTitle;
    } else if (DATA.contentType === "document") {
      bm.shortTitle = DATA.shortTitle;
      bm.section = DATA.sectionNum;
      bm.documentTitle = DATA.documentTitle;
      bm.sectionTitle = DATA.sectionTitle;
    } else {
      bm.sourceId = DATA.sourceId;
      bm.sourceTitle = DATA.sourceTitle;
    }

    var key = getBookmarkKey();
    localStorage.setItem(key, JSON.stringify(bm));
    // Note: ereader-last-opened is NOT updated here. It's only updated when
    // the user actively engages (clicks play or resume), not on periodic saves.

    // Fire-and-forget POST to server for reading progress tracking
    fetch("/api/ereader/progress", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        content_type: DATA.contentType,
        content_key: DATA.contentType === "source" ? DATA.sourceId : DATA.shortTitle,
        chapter_or_section: DATA.contentType === "textbook" ? DATA.chapterNum
                          : DATA.contentType === "document" ? DATA.sectionNum : null,
        paragraph: state.currentPara,
        total_paragraphs: state.totalParagraphs
      })
    }).catch(function() { /* silent fail */ });
  }

  function loadBookmark() {
    var key = getBookmarkKey();
    try {
      var bm = JSON.parse(localStorage.getItem(key));
      if (!bm) return null;
      // For textbooks, only restore if same chapter
      if (
        DATA.contentType === "textbook" &&
        bm.chapter !== DATA.chapterNum
      ) {
        return null;
      }
      if (
        DATA.contentType === "document" &&
        bm.section !== DATA.sectionNum
      ) {
        return null;
      }
      return bm;
    } catch (e) {
      return null;
    }
  }

  function showResumeBanner() {
    var bm = loadBookmark();
    if (!bm || bm.para < 2) return; // Don't bother for start

    var banner = document.getElementById("er-resume-banner");
    if (banner) {
      banner.style.display = "flex";
    }
  }

  // ── Media Session API ──────────────────────────────────────────
  function updateMediaSession() {
    if (!("mediaSession" in navigator)) return;

    var title =
      DATA.contentType === "textbook"
        ? "Ch " + DATA.chapterNum + ": " + DATA.chapterTitle
        : DATA.contentType === "document"
        ? "Sec " + DATA.sectionNum + ": " + DATA.sectionTitle
        : DATA.sourceTitle;

    var artist =
      DATA.contentType === "textbook"
        ? DATA.bookTitle
        : DATA.contentType === "document"
        ? DATA.documentTitle
        : "Research Source";

    navigator.mediaSession.metadata = new MediaMetadata({
      title: title,
      artist: artist,
      album: "E-Reader",
    });

    navigator.mediaSession.setActionHandler("play", function () {
      togglePlay();
    });
    navigator.mediaSession.setActionHandler("pause", function () {
      pause();
    });
    navigator.mediaSession.setActionHandler("nexttrack", function () {
      skipNext();
    });
    navigator.mediaSession.setActionHandler("previoustrack", function () {
      skipPrev();
    });
  }

  // ── Service Worker ─────────────────────────────────────────────
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker
      .register("/static/js/sw.js")
      .catch(function (err) {
        // Non-critical, just for media session persistence
        console.log("SW registration skipped:", err.message);
      });
  }

  // ── Public API (for template inline scripts) ───────────────────
  window.EReader = {
    resumeBookmark: function () {
      var bm = loadBookmark();
      if (!bm) return;

      // Restore settings
      if (bm.voice) {
        state.voice = bm.voice;
        voiceSelect.value = bm.voice;
      }
      if (bm.rate) {
        state.speed = bm.rate;
        audio.playbackRate = bm.rate;
        speedBtn.textContent = bm.rate + "x";
        speedIdx = speeds.indexOf(bm.rate);
        if (speedIdx < 0) speedIdx = 2;
      }

      // Scroll to paragraph
      var targetPara = paraEls[bm.para];
      if (targetPara) {
        targetPara.scrollIntoView({ behavior: "smooth", block: "center" });
      }

      // Start playing from bookmarked paragraph
      state.currentPara = bm.para;
      state._resumeAudioTime = bm.audioTime || 0;

      // Mark this as the last-opened content (user explicitly resumed)
      localStorage.setItem("ereader-last-opened", getBookmarkKey());
      state.hasSetLastOpened = true;

      playParagraph(bm.para);

      // Hide banner
      var banner = document.getElementById("er-resume-banner");
      if (banner) banner.style.display = "none";
    },

    // ── Reader tag management ──
    addReaderTag: function () {
      var name = prompt("Add tag:");
      if (!name || !name.trim()) return;
      var mt = DATA.materialType;
      var mk = DATA.materialKey;
      fetch(
        "/api/ereader/" +
          encodeURIComponent(mt) +
          "/" +
          encodeURIComponent(mk) +
          "/tags",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: name.trim() }),
        }
      )
        .then(function (r) {
          return r.json();
        })
        .then(function (data) {
          EReader._renderReaderTags(data.tags || []);
        });
    },

    removeReaderTag: function (tagName) {
      var mt = DATA.materialType;
      var mk = DATA.materialKey;
      fetch(
        "/api/ereader/" +
          encodeURIComponent(mt) +
          "/" +
          encodeURIComponent(mk) +
          "/tags/" +
          encodeURIComponent(tagName),
        { method: "DELETE" }
      )
        .then(function (r) {
          return r.json();
        })
        .then(function (data) {
          EReader._renderReaderTags(data.tags || []);
        });
    },

    _renderReaderTags: function (tags) {
      var container = document.getElementById("er-reading-tags");
      if (!container) return;
      // Remove all children except the + button
      var addBtn = document.getElementById("btn-add-tag");
      while (container.firstChild) container.removeChild(container.firstChild);
      tags.forEach(function (t) {
        var chip = document.createElement("span");
        chip.className = "tag-chip removable";
        chip.setAttribute("data-tag", t);
        chip.textContent = t + " ";
        var removeBtn = document.createElement("button");
        removeBtn.className = "tag-remove";
        removeBtn.textContent = "\u00D7";
        removeBtn.onclick = function () {
          EReader.removeReaderTag(t);
        };
        chip.appendChild(removeBtn);
        container.appendChild(chip);
      });
      container.appendChild(addBtn);
    },
  };

  // ── Event bindings ─────────────────────────────────────────────
  playBtn.addEventListener("click", togglePlay);
  prevBtn.addEventListener("click", skipPrev);
  nextBtn.addEventListener("click", skipNext);
  speedBtn.addEventListener("click", cycleSpeed);
  voiceSelect.addEventListener("change", changeVoice);
  progressBar.addEventListener("click", seekProgress);

  // Periodic bookmark save during playback
  state.bookmarkInterval = setInterval(function () {
    if (state.playing) {
      saveBookmark();
    }
  }, 5000);

  // Keyboard shortcuts
  document.addEventListener("keydown", function (e) {
    // Don't capture if typing in an input
    if (e.target.tagName === "INPUT" || e.target.tagName === "SELECT") return;

    switch (e.code) {
      case "Space":
        e.preventDefault();
        togglePlay();
        break;
      case "ArrowRight":
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          skipNext();
        }
        break;
      case "ArrowLeft":
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          skipPrev();
        }
        break;
    }
  });

  // ── Init ───────────────────────────────────────────────────────
  showResumeBanner();
  updateParaIndicator();

  // Pre-generate first paragraph for instant start
  generateTTS(0, Math.min(2, state.totalParagraphs));
})();
