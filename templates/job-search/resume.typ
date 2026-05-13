// Job-search resume template — matches the visual style of the user's existing
// application PDFs in ~/ed-jobs-scraper/notes/<employer>-application/.
//
// Usage:
//   typst compile --input name=<name> --input contact=<contact-line> \
//                 --input body-path=<path-to-resume-body.md> resume.typ <out.pdf>
//
// The script that invokes this template splits the drafter's full markdown
// into header (name + contact) and body, then passes them in. The body is
// rendered through cmarker, which converts CommonMark to Typst content.

#import "@preview/cmarker:0.1.6": render as md-render

#let name = sys.inputs.at("name", default: "Kevin Hopper")
#let contact = sys.inputs.at("contact", default: "")
#let body-path = sys.inputs.at("body-path", default: "")
#let body-text = if body-path != "" { read(body-path) } else { "" }

#let sans = "Liberation Sans"
#let serif = "Liberation Serif"

#set page(
  paper: "us-letter",
  margin: (top: 0.7in, bottom: 0.7in, left: 0.85in, right: 0.85in),
)
#set text(font: serif, size: 10.5pt, lang: "en")
#set par(leading: 0.55em, justify: false)

// H1 in body (the drafter shouldn't emit one but be defensive)
#show heading.where(level: 1): h => {
  v(0.6em)
  text(font: sans, weight: "bold", size: 13pt, h.body)
  v(0.2em)
}

// H2 = SECTION HEADER (ALL-CAPS, rule below) — matches existing PDFs
#show heading.where(level: 2): h => {
  block(
    above: 0.7em,
    below: 0.3em,
    {
      text(font: sans, weight: "bold", size: 11pt, upper(h.body))
      v(-0.2em)
      line(length: 100%, stroke: 0.6pt + black)
    },
  )
}

// H3 = SUB-HEADER (bold serif, no rule) — job titles, school names, etc.
#show heading.where(level: 3): h => {
  block(
    above: 0.7em,
    below: 0.4em,
    text(weight: "bold", size: 10.5pt, h.body),
  )
}

// Tight bullets
#set list(indent: 0.6em, marker: ([•]), spacing: 0.55em)

// Header block: name + contact line
#text(font: sans, weight: "bold", size: 22pt, name)
#v(-0.1em)
#text(font: sans, size: 9.5pt, contact)
#v(0.3em)

// Body
#md-render(body-text)
