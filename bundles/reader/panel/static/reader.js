/** Read view client — resume scroll + progress reporting (no TTS yet). */
const dataEl = document.getElementById("reader-data");
if (dataEl) {
  const DATA = JSON.parse(dataEl.textContent);
  const paras = document.querySelectorAll(".er-para");

  // Resume: scroll to the saved paragraph.
  if (DATA.resumeParagraph > 0 && paras[DATA.resumeParagraph]) {
    paras[DATA.resumeParagraph].classList.add("resume-target");
    paras[DATA.resumeParagraph].scrollIntoView({ block: "center" });
  }

  // Progress: furthest paragraph that has crossed mid-viewport, debounced POST.
  let furthest = DATA.resumeParagraph || 0;
  let timer = null;
  const observer = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      const idx = Number(e.target.dataset.para);
      if (idx > furthest) {
        furthest = idx;
        clearTimeout(timer);
        timer = setTimeout(save, 2000);
      }
    }
  }, { rootMargin: "-40% 0px -40% 0px" });
  paras.forEach((p) => observer.observe(p));

  function save() {
    navigator.sendBeacon?.("/api/reader/progress", new Blob([JSON.stringify({
      document_id: DATA.documentId,
      section_number: DATA.sectionNumber,
      paragraph: furthest,
      total_paragraphs: DATA.totalParagraphs,
    })], { type: "application/json" })) ||
    fetch("/api/reader/progress", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ document_id: DATA.documentId,
        section_number: DATA.sectionNumber, paragraph: furthest,
        total_paragraphs: DATA.totalParagraphs }),
    }).catch(() => {});
  }
  window.addEventListener("pagehide", save);
}
