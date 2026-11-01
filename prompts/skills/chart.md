A chart block is a Chart.js config written as JSON, and the card draws it for you: you write the
config, the board renders it and hands back the picture. It is for a shape the reader has to see — a
count climbing per hour, a rate per endpoint — and a table wins whenever the exact values matter,
because the numbers are there to read and the shape can be taken from them.

## The four keys that have to be right

```chart
{
  "type": "bar",
  "data": {
    "labels": ["09:00", "10:00", "11:00"],
    "datasets": [{ "label": "errors (count)", "data": [12, 9, 3] }]
  }
}
```

`type`, `data.labels`, and each dataset's `label` and `data`. Everything else has a default that is
worth having. The body is read with `JSON.parse`: double quotes on every key and every string, no
trailing comma, no comment.

## The keys worth knowing

- `type` is one of `bar`, `line`, `pie`, `doughnut`, `polarArea`, `radar`, `bubble`, `scatter`. Those
  eight are what the board registers; anything else draws nothing.
- `data.labels` is one string per point, in the order the values are given.
- `data.datasets` is a list, one entry per series: `label`, the name the legend and the tooltip use;
  `data`, one value per label; `backgroundColor`, `borderColor`, `borderWidth` and `fill` for its look;
  and `type`, so one dataset can be a line inside a bar chart.
- `options` holds the rest, and these are the ones that earn their ink: `indexAxis: "y"` for a
  horizontal bar, `goal` for the value the reader is measuring against, `scales.y.beginAtZero`,
  `scales.y.type: "logarithmic"`, `plugins.legend.display`, `plugins.tooltip`, `plugins.title.text`.

Everything not listed still works: this is Chart.js 4.6.1, and its own options are yours to use. Four
are not: the board sets `responsive`, `animation` and `devicePixelRatio` itself, because the drawing is
snapshotted to a PNG and a live canvas cannot outlive the paint, so a config that names them is
overridden. And JSON cannot carry a function, so any option that takes a callback is out: no
`ticks.callback`, no formatter, no `external` tooltip.

## What the board draws without being asked

- Tick numbers are written short, so `1250000` reads `1.25M` and `1800` reads `1.8k`. Do not spend a
  label or a tick on the long form.
- Every mark carries its value in small grey type when the chart holds twelve marks or fewer and at
  most two series. `options: { "valueLabels": false }` turns that off.
- A dataset that names no `backgroundColor` or `borderColor` takes the board's palette, and a line
  takes the same colour as a light fill. A colour you do name is kept.
- `"goal": 250` draws a dashed rule at 250, labelled with the number: a plain number survives JSON,
  which is why a goal line is one option rather than something to draw.

## The rules

- Ten labels or fewer, unless the card is `wide`. Past that the labels are rotated into a smear.
- `indexAxis: "y"` when the labels are long: a horizontal bar has room for the word.
- One chart per card. A second one competes with the first for the same glance.
- Sort the data before you write it. A chart does not sort itself, and unsorted bars hide the answer.
- Put the unit in the dataset label, `"latency (ms)"`, rather than repeating it at every tick.
- No chart for a single number. One value is a sentence.

## Examples

### OK — errors per hour, one series

```chart
{
  "type": "bar",
  "data": {
    "labels": ["09:00", "10:00", "11:00", "12:00"],
    "datasets": [{ "label": "errors (count)", "data": [12, 9, 3, 2] }]
  }
}
```

Four points, short labels, one series: the drop reads in one glance and the unit sits in the label.

### OK — the worst endpoints first, named in full

```chart
{
  "type": "bar",
  "data": {
    "labels": ["POST /api/v1/boards/:id/notes", "GET /api/v1/boards/:id/cards", "POST /api/v1/boards/:id/threads"],
    "datasets": [{ "label": "failures (count)", "data": [41, 17, 6], "backgroundColor": "#f85149" }]
  },
  "options": { "indexAxis": "y", "scales": { "x": { "beginAtZero": true } } }
}
```

`indexAxis: "y"` because the labels are paths, and the rows arrive in descending order because the
question is which one is biggest.

### OK — a line over a bar, one card

```chart
{
  "type": "bar",
  "data": {
    "labels": ["09:00", "10:00", "11:00", "12:00"],
    "datasets": [
      { "label": "p95 (ms)", "data": [180, 240, 610, 430], "backgroundColor": "#1f6feb" },
      { "type": "line", "label": "retries (count)", "data": [2, 5, 14, 8], "borderColor": "#f85149", "fill": false }
    ]
  },
  "options": { "scales": { "y": { "beginAtZero": true } } }
}
```

Two series that share a story, four points each, and the second dataset's own `type` gives the retries
a line instead of a second chart.

### OK — a goal line over the bars

```chart
{
  "type": "bar",
  "data": {
    "labels": ["2024-11", "2024-12", "2025-01"],
    "datasets": [{ "label": "requests (count)", "data": [74000, 91000, 118000] }]
  },
  "options": { "goal": 100000, "indexAxis": "y" }
}
```

Reach for `goal` when one number is the pass mark and the question is which bars clear it: the rule
and its label are the comparison, and no second series is needed to draw it.

### NOK — a callback the config cannot carry

```chart
{
  "type": "line",
  "data": {
    "labels": ["09:00", "10:00"],
    "datasets": [{ "label": "p95 (ms)", "data": [180, 240] }]
  },
  "options": { "scales": { "y": { "ticks": { "callback": (value) => value + "ms" } } } }
}
```

The body stops being JSON the moment a function is in it, so nothing draws and the tool reports the
parse error. The unit already sits in the dataset label; adding `"ms"` to every tick buys nothing.

### NOK — twelve series nobody can read

```chart
{
  "type": "line",
  "data": {
    "labels": ["09:00", "10:00"],
    "datasets": [
      { "label": "p25 (ms)", "data": [60, 70] },
      { "label": "p50 (ms)", "data": [90, 110] },
      { "label": "p75 (ms)", "data": [140, 160] },
      { "label": "p90 (ms)", "data": [180, 240] },
      { "label": "p95 (ms)", "data": [220, 300] },
      { "label": "p99 (ms)", "data": [410, 560] },
      { "label": "p999 (ms)", "data": [980, 1400] },
      { "label": "min (ms)", "data": [40, 50] },
      { "label": "max (ms)", "data": [1200, 1600] },
      { "label": "mean (ms)", "data": [110, 150] },
      { "label": "stddev (ms)", "data": [75, 90] },
      { "label": "count (n)", "data": [3, 5] }
    ]
  }
}
```

Twelve lines in a card about 400px wide is a smear with no readable order. Keep the two series the
question is about, or write a table.

When a chart block fails to parse, the tool reports why. The fix is to correct the block: rewrite it as
JSON with a `type` and a `data`, or drop the chart and put the number in a sentence.
