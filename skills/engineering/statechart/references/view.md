# Shape the chart

View rules beyond the basics in [SKILL.md](../SKILL.md): conditions on steps, phase colors and a title, and a busy chart.

## Conditions

When a step can occur only in some conditions, end its label with the condition in brackets, in the reader's words, such as `you press play [while the file loads]`.

In a regions chart, the command writes a condition on the other regions onto the arrow, in the words of their labels, such as `[when Offline]`. Your brackets replace it, and two arrows from one state can then look the same. So in a regions chart, leave a condition on another region to the command.

## Phases, colors and title

- `group(vars)` returns the name of a phase. Each chart state gets the color of its group. When the model states behind one chart state are in different groups, that state gets no color.
- `colors` gives each group name a color class.
- `title` is a string that the chart shows at the top.

## A busy chart

Aim for about 20 arrows or fewer, because a busier chart is hard to read. First return coarser labels from `state()`. Give one label to values that act the same, and leave out a detail the reader does not need, such as a call in flight whose return changes nothing. Keep each state of a bug path, and keep each mark. A merge that changes a `breaks` state to `mayBreak` hides where a rule breaks. Keep apart two states that break different rules, so the reader can see which rule breaks where.

If the chart is still too busy, return `null` from `step()` for the steps the reader does not need, such as a reset that every state has, or a step whose arrow repeats what other arrows show. When you hide steps:

- Keep each chart state reachable by arrows from a start state.
- Keep at least one arrow out of each chart state that has a step out in the model.
- Hide all the steps of an arrow, or none of them. Hiding only some narrows its condition.
