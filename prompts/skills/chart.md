A chart block draws numbers the reader is meant to compare at a glance: a count per hour, a rate per
endpoint, a value over time. It is a fenced block tagged `chart`, and the card inlines it. When the
reader needs exact values, a table beats a chart: the numbers are there to read, and the shape can be
taken from them.

## The grammar

```chart
type: bar
title: errors per hour
x: time
y: errors (count)
scale: linear
sort: none
labels: auto
goal: 5
---
09:00,12
10:00,9
11:00,3
```

- `type` is `bar`, `hbar`, `line` or `area`.
- `title` is the one line above the drawing.
- `x` is `category`, `time` or `number`, and it names what the first column of the data means.
- `y` is one or more series, each written `label (unit)`. A series measured against the second axis
  ends with `right`: `retries (count) right`.
- `scale` is `linear` or `log`.
- `sort` is `none`, `asc` or `desc`.
- `labels` is `auto`, `all` or `none`.
- `goal` is one number, drawn as a line the bars are measured against.
- Everything after the `---` line is data. One row is one point: the x value, then one value per
  series, in the order those series were declared.
- A key the tool does not know is ignored and reported back to you. It is never fatal.

## The rules

- Ten categories or fewer, unless the card is `wide`. Past that the bars are hairlines.
- `hbar` when the labels are long: a horizontal bar has room for the word, a vertical one does not.
- `sort: desc` when the point is which one is biggest. Alphabetical order hides the answer.
- Put the unit in the series header, `latency (ms)`, not in every value.
- `labels: all` only when there are eight points or fewer. Otherwise let `auto` choose.
- No chart for a single number. One value is a sentence.

## Examples

### OK — a few hours of errors

```chart
type: bar
title: errors per hour
x: time
y: errors (count)
---
09:00,12
10:00,9
11:00,3
```

Four points, short labels, one series: a `bar` with the x axis as time reads the drop in a glance.

### OK — the worst endpoints first, named in full

```chart
type: hbar
title: failing requests per endpoint
x: category
y: failures (count)
sort: desc
labels: all
goal: 20
---
POST /api/v1/boards/:id/notes,41
GET /api/v1/boards/:id/cards,17
POST /api/v1/boards/:id/threads,6
```

`hbar` because the labels are paths, `sort: desc` because the question is which one is biggest, and
the goal line gives the 20 the human asked about.

### OK — two series, one on the right axis

```chart
type: line
title: board latency and retries
x: time
y: p95 (ms), retries (count) right
scale: linear
---
09:00,180,2
10:00,240,5
11:00,610,14
12:00,430,8
```

The unit sits in each series header, and `right` keeps a count of retries off the millisecond axis
that would otherwise flatten it.

### NOK — a chart of one value

```chart
type: bar
title: test suite
x: category
y: passing (tests)
---
suite,412
```

One bar carries no comparison. Write "412 tests pass" in the line and drop the block.

### NOK — twelve series nobody can read

```chart
type: line
title: latency, every percentile
x: time
y: p25 (ms), p50 (ms), p75 (ms), p90 (ms), p95 (ms), p99 (ms), p999 (ms), min (ms), max (ms), mean (ms), stddev (ms), count (n) right
---
09:00,60,90,140,180,220,410,980,40,1200,110,75,3
10:00,70,110,160,240,300,560,1400,50,1600,150,90,5
```

Twelve lines in a card 430px wide is a smear with no readable order. Keep the two series the question
is about, or write a table.

When a chart block fails to parse, the tool reports why. Correct the block; do not fall back to prose.
