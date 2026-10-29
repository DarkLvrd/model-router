/**
 * The live test set: the user's 8 sample messages, tiny through hardest,
 * plus 2 short replies that only mean something inside the running
 * conversation.
 *
 * The two short replies carry `recentTurns` on purpose. Without them the
 * "is this standalone?" judgment has nothing to judge, and the whole point of
 * these two cases is that a well-formed short message is still not a job.
 */

export const SAMPLE_CONVERSATION = [
  'user: The README is way too long and reads like a spec. Can you rewrite it as something a person can actually read?',
  'assistant: Done — I cut it to about a page and moved the detail into docs/.',
  'user: Also add a table of what got routed where.',
];

export const SAMPLES = [
  {
    id: 1,
    band: 'tiny',
    expect: 'tiny',
    message: 'rename the variable `foo` to `bar` in index.js',
  },
  {
    id: 2,
    band: 'tiny',
    expect: 'tiny',
    message: 'what port does the dev server listen on?',
  },
  {
    id: 3,
    band: 'everyday',
    expect: 'everyday',
    message: 'Write a short email to the team letting them know the Friday demo moved to Monday.',
  },
  {
    id: 4,
    band: 'everyday',
    expect: 'everyday',
    message: 'Draft a 200-word LinkedIn post about the new pricing page we shipped this week.',
  },
  {
    id: 5,
    band: 'large',
    expect: 'large',
    message:
      'Build a script that reads our monthly CSV exports, dedupes customers by email address, ' +
      'and writes a summary report with totals per month.',
  },
  {
    id: 6,
    band: 'large',
    expect: 'large',
    message:
      'Research the three cheapest ways to host a small Postgres database for a side project ' +
      'and write up a recommendation with the trade-offs.',
  },
  {
    id: 7,
    band: 'hardest',
    expect: 'hardest',
    message:
      'Map out a three-year strategy for entering the EU market with a 2M dollar budget. ' +
      'A wrong call here is expensive.',
  },
  {
    id: 8,
    band: 'hardest',
    expect: 'hardest',
    message:
      'Decide whether we should drop our biggest client to free up the team. Give me the call ' +
      'and the reasoning you would defend to the board.',
  },
  {
    id: 9,
    band: 'short reply',
    expect: 'in_place',
    message: 'yes do that but make it shorter',
    recentTurns: SAMPLE_CONVERSATION,
  },
  {
    id: 10,
    band: 'short reply',
    expect: 'in_place',
    message: 'ok, and what about the second one?',
    recentTurns: SAMPLE_CONVERSATION,
  },
];
