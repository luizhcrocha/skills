import { describe, expect, test } from 'claude-code/testing'
import type { On, PromptOrigin } from 'claude-code'
import type { Engine } from 'claude-code/testing'

import { mergeSources, orderActivePrompts, selectEntries, truncate } from '../hooks/register'

const PLUGIN = 'prompt-jump'
const PANE = 'prompt-jump'
const BODY_COLUMNS = 60
const PRESENTATION = { isFullscreen: true, columns: 120 }

const COMPOSER: PromptOrigin = { kind: 'composer' }
const TASK_NOTIFICATION: PromptOrigin = { kind: 'task-notification' }
const UNCLASSIFIED: PromptOrigin = { kind: 'unclassified' }

type Stored = { role: 'user' | 'assistant'; text: string }

const user = (text: string): Stored => ({ role: 'user', text })
const assistant = (text: string): Stored => ({ role: 'assistant', text })

// 엔진 역할(첫 $ 호출 전에 등록): UserMessage 행 그리기, 현재 대화 기록, 패널 열기에 답한다.
// messages를 생략하면 대화 기록을 읽지 못하는 상황
const answerAsEngine = (on: On, messages?: readonly Stored[]) => {
  on('ui.render', { component: 'UserMessage' }, ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text>{e.props.text}</Text>
  })
  if (messages) on('session.messages', () => ({ value: messages.map(message => ({ ...message, toolUses: [] })) }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
}

const HOME = '/Users/me'
const SESSION_ID = 'sid'
const TRANSCRIPT = `${HOME}/.claude/projects/-Users-me-proj/${SESSION_ID}.jsonl`

// 엔진 역할: 세션 기록 파일 위치를 알려주고, 그 파일에 대한 grep 결과로 jsonl을 돌려준다. 실행된 명령은 runs에 남긴다
const answerTranscript = (on: On, jsonl: string, runs: (readonly string[])[]) => {
  on('session.id', () => ({ value: SESSION_ID }))
  on('session.root', () => ({ value: '/Users/me/proj' }))
  on('env.get', ($, e) => ({ value: e.name === 'HOME' ? HOME : undefined }))
  on('fs.exists', ($, e) => ({ value: e.path === TRANSCRIPT }))
  on('process.run', ($, e) => {
    runs.push(e.argv)
    return { value: { exitCode: 0, stdout: jsonl, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
}

const row = (fields: Record<string, unknown>) => JSON.stringify({ type: 'user', ...fields })

const showRow = ($: Engine, requestId: string, text: string, origin: PromptOrigin = COMPOSER) =>
  $.ui.mount({
    plugin: PLUGIN,
    surface: 'terminal',
    component: 'UserMessage',
    requestId,
    props: { text, origin, isExpanded: true },
  })

const runJump = ($: Engine) => $.command.run({ command: 'jump', args: '', origin: COMPOSER, presentation: PRESENTATION })

const openPane = ($: Engine) =>
  $.ui.mount({
    plugin: PLUGIN,
    surface: 'terminal',
    component: 'Pane',
    requestId: PANE,
    props: {
      title: '프롬프트로 이동',
      isFocused: true,
      bodyColumns: BODY_COLUMNS,
      placement: 'dock',
      scroll: { offset: 0, bodyRows: 20 },
      view: {},
    },
  })

const listedKeys = async (pane: Awaited<ReturnType<typeof openPane>>) =>
  (await pane.findAll({ type: 'Button' })).map(button => button.key)

describe('prompt-jump', () => {
  test('givenRowsDrawnOutOfOrderWithRewoundAndCommandRows_whenJumpOpens_thenListsActivePromptsNewestFirst', async ($, on) => {
    answerAsEngine(on, [
      user('첫 번째 질문'),
      assistant('답변'),
      user('두 번째 질문'),
      user('<command-name>/plugin</command-name>\n<command-message>plugin</command-message>'),
      user('세 번째 질문'),
    ])
    // fullscreen처럼 화면 밖 행이 나중에 그려진 상황: 그려진 순서 ≠ 대화 순서
    await showRow($, 'm3', '세 번째 질문')
    await showRow($, 'm1', '첫 번째 질문')
    await showRow($, 'rewound', 'dev-mods에 있는 복사본 지워줘')
    await showRow($, 'cmd', '/plugin')
    await showRow($, 'note', '백그라운드 작업 완료', TASK_NOTIFICATION)
    await showRow($, 'm2', '두 번째 질문')

    await runJump($)
    const pane = await openPane($)

    expect(await listedKeys(pane)).toEqual(['p-m3', 'p-m2', 'p-m1'])
    expect((await pane.find({ type: 'Text', text: /3\/3개/ }))?.text).toContain('3/3개')
  })

  // resume 직후: 아직 스크롤해 보지 않아 화면에 그려진 행이 하나도 없는 상황
  test('givenResumedSessionWithNoDrawnRows_whenJumpOpens_thenListsPromptsFromTranscript', async ($, on) => {
    answerAsEngine(on, [user('resume 전 첫 질문'), assistant('답변'), user('resume 전 두 번째 질문')])
    const runs: (readonly string[])[] = []
    answerTranscript(
      on,
      [
        row({ uuid: 'u1', promptSource: 'typed', message: { content: 'resume 전 첫 질문' } }),
        row({ uuid: 'rewound', promptSource: 'typed', message: { content: '되감기한 질문' } }),
        row({ uuid: 'cmd', promptSource: 'typed', message: { content: '<command-name>/plugin</command-name>' } }),
        row({ uuid: 'u2', promptSource: 'queued', message: { content: [{ type: 'text', text: 'resume 전 두 번째 질문' }] } }),
        row({ uuid: 'note', promptSource: 'system', isMeta: true, message: { content: 'Another Claude session sent' } }),
        '{"type":"user","uuid":"cut',
      ].join('\n'),
      runs,
    )

    await runJump($)
    const pane = await openPane($)

    expect(runs).toEqual([['grep', '-F', '"promptSource":', TRANSCRIPT]])
    expect(await listedKeys(pane)).toEqual(['p-u2', 'p-u1'])
  })

  // resume으로 불러온 행은 composer 표시 없이 온다
  test('givenRowsLoadedOnResume_whenJumpOpens_thenListsThem', async ($, on) => {
    answerAsEngine(on, [user('resume 전 질문'), assistant('답변'), user('resume 후 질문')])
    await showRow($, 'loaded', 'resume 전 질문', UNCLASSIFIED)
    await showRow($, 'typed', 'resume 후 질문')

    await runJump($)
    const pane = await openPane($)

    expect(await listedKeys(pane)).toEqual(['p-typed', 'p-loaded'])
  })

  test('givenNumberQuery_whenTyped_thenKeepsOnlyThatNumber', async ($, on) => {
    answerAsEngine(on, [user('첫 번째 질문'), user('두 번째 질문'), user('세 번째 질문')])
    await showRow($, 'm1', '첫 번째 질문')
    await showRow($, 'm2', '두 번째 질문')
    await showRow($, 'm3', '세 번째 질문')
    await runJump($)
    const pane = await openPane($)

    await pane.input({ key: 'filter', text: '2', kind: 'change' })
    expect(await listedKeys(pane)).toEqual(['p-m2'])

    await pane.input({ key: 'filter', text: '#3', kind: 'change' })
    expect(await listedKeys(pane)).toEqual(['p-m3'])
  })

  test('givenFilterTerms_whenTyped_thenKeepsOnlyPromptsContainingAllTerms', async ($, on) => {
    answerAsEngine(on, [
      user('CLAUDE.md 파일을 검토해줘.'),
      user('defaultMode bypass로 바꿔줘'),
      user('bypass 모드 trade-off 알려줘'),
    ])
    await showRow($, 'm1', 'CLAUDE.md 파일을 검토해줘.')
    await showRow($, 'm2', 'defaultMode bypass로 바꿔줘')
    await showRow($, 'm3', 'bypass 모드 trade-off 알려줘')
    await runJump($)
    const pane = await openPane($)

    await pane.input({ key: 'filter', text: 'BYPASS 바꿔', kind: 'change' })

    expect(await listedKeys(pane)).toEqual(['p-m2'])
  })

  test('givenSessionMessagesUnavailable_whenJumpOpens_thenFallsBackToDrawnOrder', async ($, on) => {
    answerAsEngine(on)
    await showRow($, 'm1', '첫 번째 질문')
    await showRow($, 'm2', '두 번째 질문')

    await runJump($)
    const pane = await openPane($)

    expect(await listedKeys(pane)).toEqual(['p-m2', 'p-m1'])
  })

  // 테스트 키트에는 transcript 행 스크롤 구현이 없다(실제 이동은 세션에서 확인). 실패 경로가 패널을 깨지 않는지만 본다
  test('givenScrollUnavailable_whenPromptPressed_thenToastsReasonInsteadOfFailing', async ($, on) => {
    answerAsEngine(on, [user('첫 번째 프롬프트')])
    const toasts: string[] = []
    on('ui.toast', ($, e) => {
      toasts.push(e.text)
      return { value: undefined }
    })
    await showRow($, 'm1', '첫 번째 프롬프트')
    await runJump($)

    const pane = await openPane($)
    await pane.press({ key: 'p-m1' })

    expect(toasts).toHaveLength(1)
    expect(toasts[0]).toContain('해당 위치로 이동하지 못했어')
    expect(await pane.find({ key: 'p-m1' })).toBeDefined()
  })
})

describe('orderActivePrompts', () => {
  test('givenPromptResentAfterRewind_whenOrdered_thenPicksNewestDrawnRow', () => {
    const rendered = [
      ['old', '같은 질문'],
      ['other', '다른 질문'],
      ['new', '같은 질문'],
    ] as const

    const ids = orderActivePrompts(rendered, [user('다른 질문'), user('같은 질문')]).map(entry => entry.id)

    expect(ids).toEqual(['other', 'new'])
  })

  test('givenWhitespaceDifferences_whenOrdered_thenStillMatches', () => {
    const ids = orderActivePrompts([['m1', '여러 줄\n프롬프트']], [user('여러 줄  프롬프트')]).map(entry => entry.id)

    expect(ids).toEqual(['m1'])
  })
})

describe('mergeSources', () => {
  test('givenTranscriptAndDrawnIdsDiffer_whenOrdered_thenPrefersDrawnRowId', () => {
    const candidates = mergeSources([['uuid-1', '질문']], [['row-1', '질문']])

    expect(orderActivePrompts(candidates, [user('질문')])).toEqual([{ id: 'row-1', text: '질문' }])
  })

  test('givenSameIds_whenMerged_thenKeepsTranscriptOrderWithoutDuplicates', () => {
    const merged = mergeSources(
      [
        ['a', '첫 번째'],
        ['b', '두 번째'],
      ],
      [['b', '두 번째']],
    )

    expect(merged.map(([id]) => id)).toEqual(['a', 'b'])
  })
})

describe('selectEntries', () => {
  const entries = [
    { text: 'alpha 12', no: 1 },
    { text: 'beta', no: 12 },
  ]

  test('givenDigitsOnly_whenSelected_thenMatchesNumberExactly', () => {
    expect(selectEntries(entries, '12')).toEqual([{ text: 'beta', no: 12 }])
  })

  test('givenDigitsWithText_whenSelected_thenSearchesText', () => {
    expect(selectEntries(entries, 'alpha 12')).toEqual([{ text: 'alpha 12', no: 1 }])
  })
})

describe('truncate', () => {
  test('givenKoreanTextWiderThanWidth_whenTruncated_thenFitsCellWidthWithEllipsis', () => {
    // 한글 1자 = 2칸: 폭 7이면 3자(6칸) + 말줄임표(1칸)
    expect(truncate('가나다라마', 7)).toBe('가나다…')
  })

  test('givenTextWithinWidth_whenTruncated_thenUnchanged', () => {
    expect(truncate('abc', 3)).toBe('abc')
  })
})
