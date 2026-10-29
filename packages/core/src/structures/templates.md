# The template notation

The notation a scenario's spec writes its structure in when its adapter reads
templates, as the commit scenario's does. The templates sit in the spec's
fenced `template` block, and they are the structure's one definition: the
adapter checks a draft against them, lays the approved text out by them, and
builds a draft from typed text by them.

## Blocks

A block defines one element: its name at the margin, then indented header
lines `key: value`, an empty line, and the indented template, drawn as the
output looks. The first block is the root. A line starting with `#` is a
comment.

```template
bullet
  - {{line}}
    {{line}}*
```

- `{{name}}` is a child, in order, with `?`, `+` or `*` for its repetition:
  at most one, at least one, any number. Without a mark it occurs once.
- Text around a placeholder is literal and comes out as drawn, such as the
  `- ` before a bullet's first line. An empty line inside a template is an
  empty line of the output.
- `{{text}}` is the one built-in: the characters a leaf holds. It stands
  alone, so a block is either a leaf or a container.
- `line` is the leaf a draft is addressed by: each `<line>` gets an id, takes
  comments and is amended.

## Headers

- `width` — the limit an output line may reach, marker and indentation
  counted, or `none`. The nearest container that sets one wins over the
  leaf's own. A draft over it is refused.
- `separator` — what the output puts between a block's repeated children:
  `blank` for an empty line, `newline`, or a quoted string such as `" "`,
  which joins them into one output line.

## The draft

A draft is XML with one element per block, nested as the templates nest, and
a leaf's text as the element's content. A line is an output line and is never
folded. `message.example.xml` beside the spec is a valid draft.

## Typed text

Text typed into the page is read by the templates: paragraphs separated by
empty lines go to the root's children in order, a child whose template starts
with a literal marker such as `- ` takes each marked line as an item with the
unmarked lines after it, and a child of lines takes a whole paragraph.
