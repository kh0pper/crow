// Job-search cover-letter template — matches the visual style of the user's
// existing PDFs (cover-letter half of the drafter's output, split on
// "\n---\n# Cover Letter").
//
// Usage:
//   typst compile --input name=<name> --input contact=<contact-line> \
//                 --input body-path=<path-to-cover-body.md> cover-letter.typ <out.pdf>

#import "@preview/cmarker:0.1.6": render as md-render

#let name = sys.inputs.at("name", default: "Kevin Hopper")
#let contact = sys.inputs.at("contact", default: "")
#let body-path = sys.inputs.at("body-path", default: "")
#let body-text = if body-path != "" { read(body-path) } else { "" }

#let sans = "Liberation Sans"
#let serif = "Liberation Serif"

#set page(
  paper: "us-letter",
  margin: (top: 0.85in, bottom: 0.85in, left: 1in, right: 1in),
)
#set text(font: serif, size: 11pt, lang: "en")
#set par(leading: 0.65em, justify: false)

// Headings in cover-letter body should NOT print — the drafter sometimes
// emits an internal "# Cover Letter" marker; the split script strips it,
// but if anything leaks through we suppress the marker visually.
#show heading.where(level: 1): _ => none
#show heading.where(level: 2): h => {
  block(
    above: 0.4em,
    below: 0.2em,
    text(weight: "bold", size: 11pt, h.body),
  )
}

// Header block: name + contact (less detail than resume; just essentials)
#text(font: sans, weight: "bold", size: 22pt, name)
#v(-0.1em)
#text(font: sans, size: 10pt, contact)
#v(1.2em)

// Body
#md-render(body-text)
