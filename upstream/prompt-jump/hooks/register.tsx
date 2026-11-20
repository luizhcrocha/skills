import { atom, read, update } from 'claude-code'
import type { EngineInterface, PromptOrigin, Register, SessionMessage } from 'claude-code'

import type { MessageId, PromptEntry } from '../types'

// 기존 Ctrl+R(입력 기록 검색)은 엔진 내부 다이얼로그라 건드리지 않고, /jump 로 여는 별도 패널로 제공한다
const PANE = 'prompt-jump'
const PANE_TITLE = '프롬프트로 이동'
const MAX_LISTED = 200
const MIN_LABEL_WIDTH = 10
const ROW_GAP = '  '
const ELLIPSIS = '…'
const CURRENT_MARK = '▸'
// 프로젝트 폴더 이름이 이 길이를 넘으면 엔진이 잘라내고 해시를 붙인다
const PROJECT_DIR_NAME_MAX = 200
// grep: 1은 "일치 없음", 그 이상은 오류
const GREP_NO_MATCH = 1
// 세션 기록 파일(jsonl)에서 사람이 입력한 프롬프트 행에만 있는 필드. 슬래시 명령·도구 결과 행에는 없다
const PROMPT_ROW_MARKER = '"promptSource":'

const filter = atom({ plugin: 'prompt-jump', key: 'filter' } as const, '')
const current = atom({ plugin: 'prompt-jump', key: 'current' } as const, '')
const listedEntries = atom({ plugin: 'prompt-jump', key: 'entries' } as const, [])

// 화면에 그려진 UserMessage 행의 id(requestId) → 원문. 이번 프로세스에서 그려진 행만 담긴다
// (resume 직후 아직 스크롤해 보지 않은 행은 없으므로 세션 기록 파일로 보충한다)
// render hook 안에서는 $.state 쓰기가 금지라 모듈 변수에 둔다
const prompts = new Map<MessageId, string>()

// 사람이 입력하지 않은 출처: 작업 알림, 예약 실행, 다른 세션·채널·플러그인이 보낸 메시지
const NON_PROMPT_KINDS: ReadonlySet<PromptOrigin['kind']> = new Set([
  'task-notification',
  'scheduled-trigger',
  'peer',
  'peer-send-message',
  'projects-relay',
  'channel',
  'coordinator',
  'observer',
  'observer-activity',
  'auto-continuation',
  'slack-ping',
  'plugin',
])

// 허용 목록(composer·bridge)이 아니라 제외 목록으로 거른다: resume으로 불러온 행은 출처가 저장 형식({ kind: 'human' })과 달라
// composer로 오지 않기 때문. 출처 표시가 없는 팀원 메시지(from)·작업 알림(task)도 뺀다
const isTypedPrompt = (origin: PromptOrigin, hasSender: boolean) => !NON_PROMPT_KINDS.has(origin.kind) && !hasSender

// 슬래시 명령 행(/rewind, /resume, /plugin …)은 대화 프롬프트가 아니라 제외. "/Users/..." 처럼 경로로 시작하는 프롬프트는 남긴다
const SLASH_COMMAND = /^\/[\w:-]+(\s|$)/
const isSlashCommand = (text: string) => {
  const head = text.trimStart()
  return SLASH_COMMAND.test(head) || head.startsWith('<command-name>') || head.startsWith('<local-command-')
}

// 터미널에서 2칸을 차지하는 문자 범위(한글·CJK·전각·이모지). 글자 수로 자르면 한국어 행이 줄바꿈되어 목록이 깨진다
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f],
  [0x2e80, 0xa4cf],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe30, 0xfe4f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x1f300, 0x1faff],
  [0x20000, 0x3fffd],
]

const cellWidth = (ch: string) => {
  const code = ch.codePointAt(0) ?? 0
  return WIDE_RANGES.some(([low, high]) => code >= low && code <= high) ? 2 : 1
}

const displayWidth = (text: string) => [...text].reduce((sum, ch) => sum + cellWidth(ch), 0)

export const truncate = (text: string, width: number) => {
  if (displayWidth(text) <= width) return text
  let used = 0
  let kept = ''
  for (const ch of text) {
    const w = cellWidth(ch)
    // 말줄임표 1칸을 남겨둔다
    if (used + w > width - 1) break
    used += w
    kept += ch
  }
  return kept + ELLIPSIS
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim()

// 서로 다른 출처의 텍스트를 비교하는 키: 줄바꿈·블록 결합 방식 차이를 무시하려고 공백을 모두 뺀다
const matchKey = (text: string) => text.replace(/\s+/g, '')

type CandidatePrompt = readonly [id: MessageId, text: string]
type StoredMessage = Pick<SessionMessage, 'role' | 'text' | 'toolResults'>

// 세션 기록 파일의 한 행 중 필요한 필드만
type TranscriptRow = {
  type?: unknown
  uuid?: unknown
  isMeta?: unknown
  promptSource?: unknown
  message?: { content?: unknown }
}

const parseRow = (line: string): TranscriptRow | undefined => {
  try {
    const row: unknown = JSON.parse(line)
    return typeof row === 'object' && row !== null ? row : undefined
  } catch {
    // 잘린 마지막 줄 등 깨진 행은 건너뛴다
    return undefined
  }
}

const isTextBlock = (block: unknown): block is { type: 'text'; text: string } =>
  typeof block === 'object' &&
  block !== null &&
  'type' in block &&
  block.type === 'text' &&
  'text' in block &&
  typeof block.text === 'string'

// 메시지 content는 문자열이거나 블록 배열(이미지 첨부 등): 텍스트 블록만 잇는다
const contentText = (content: unknown) => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .filter(isTextBlock)
    .map(block => block.text)
    .join('\n')
}

// 기록 파일 행들(jsonl)에서 사람이 입력한 프롬프트만 기록 순서대로 뽑는다. 되감기로 버려진 분기의 프롬프트도 포함된다
export const parsePromptRows = (jsonl: string): CandidatePrompt[] =>
  jsonl.split('\n').flatMap(line => {
    const row = parseRow(line)
    if (!row || row.type !== 'user' || row.isMeta === true || row.promptSource === 'system') return []
    if (typeof row.uuid !== 'string') return []

    const text = contentText(row.message?.content)
    return text.trim() && !isSlashCommand(text) ? [[row.uuid, text] as const] : []
  })

// 기록 파일의 프롬프트 뒤에, 기록 파일에 없는 id로 그려진 행을 덧붙인다.
// 보통 둘의 id는 같아 그대로 기록 파일 순서가 되고, 혹시 다르면 같은 텍스트끼리 짝지을 때 나중 항목(그려진 행)이 우선한다
export const mergeSources = (stored: readonly CandidatePrompt[], rendered: readonly CandidatePrompt[]) => {
  const storedIds = new Set(stored.map(([id]) => id))
  return [...stored, ...rendered.filter(([id]) => !storedIds.has(id))]
}

// 현재 대화(되감기로 버려진 분기 제외)에 남아 있는 프롬프트만 대화 순서(오래된 → 최신)로 돌려준다
export const orderActivePrompts = (
  candidates: readonly CandidatePrompt[],
  messages: readonly StoredMessage[],
): PromptEntry[] => {
  // 같은 텍스트가 여러 번이면 후보 순서대로 쌓아둔다
  const byKey = new Map<string, CandidatePrompt[]>()
  for (const candidate of candidates) {
    const key = matchKey(candidate[1])
    byKey.set(key, [...(byKey.get(key) ?? []), candidate])
  }

  // 최신 메시지부터 짝지으며 같은 텍스트 중 가장 나중 후보를 쓴다:
  // rewind 후 같은 프롬프트를 다시 보낸 경우 버려진 예전 행이 아니라 현재 대화의 새 행을 고르기 위함
  const newestFirst: PromptEntry[] = []
  for (const message of [...messages].reverse()) {
    if (message.role !== 'user' || message.toolResults?.length) continue
    const candidate = byKey.get(matchKey(message.text))?.pop()
    if (candidate) newestFirst.push({ id: candidate[0], text: candidate[1] })
  }

  return newestFirst.reverse()
}

// 세션 기록 파일 위치: <설정 폴더>/projects/<프로젝트 루트의 영숫자 외 문자를 '-'로 바꾼 이름>/<세션 id>.jsonl
const findTranscript = async ($: EngineInterface) => {
  const [id, root, configDir, home] = await Promise.all([
    $.session.id(),
    $.session.root(),
    $.env.get('CLAUDE_CONFIG_DIR'),
    $.env.get('HOME'),
  ])
  const baseDir = configDir ?? (home && `${home}/.claude`)
  if (!baseDir) return undefined

  const projectsDir = `${baseDir}/projects`
  const dirName = root.replace(/[^a-zA-Z0-9]/g, '-')
  const direct = `${projectsDir}/${dirName}/${id}.jsonl`
  if (dirName.length <= PROJECT_DIR_NAME_MAX && (await $.fs.exists(direct))) return direct

  // 긴 경로는 폴더 이름이 잘리고 해시가 붙으므로 세션 id로 찾는다
  const found = await $.process.run(['find', projectsDir, '-maxdepth', '2', '-name', `${id}.jsonl`])
  return found.stdout.split('\n').find(Boolean)
}

// 기록 파일 전체(수 MB)를 읽지 않고 프롬프트 행만 grep으로 뽑는다 ($.fs.read는 4 MiB 초과 파일을 거부한다)
const readTranscriptPrompts = async ($: EngineInterface) => {
  const path = await findTranscript($)
  if (!path) return []

  const result = await $.process.run(['grep', '-F', PROMPT_ROW_MARKER, path])
  if (result.exitCode > GREP_NO_MATCH) return []
  return parsePromptRows(result.stdout)
}

// 공백으로 나눈 검색어를 모두 포함해야 매치 (대소문자 무시)
const toTerms = (query: string) => query.toLowerCase().split(/\s+/).filter(Boolean)

const matchesAll = (text: string, terms: readonly string[]) => {
  const lower = text.toLowerCase()
  return terms.every(term => lower.includes(term))
}

// 숫자만 입력하면(# 생략 가능) 그 번호 하나만, 그 외에는 텍스트 검색
const NUMBER_QUERY = /^#?(\d+)$/

export const selectEntries = <E extends { text: string; no: number }>(entries: readonly E[], query: string): E[] => {
  const number = NUMBER_QUERY.exec(query.trim())
  if (number) return entries.filter(entry => entry.no === Number(number[1]))

  const terms = toTerms(query)
  return entries.filter(entry => matchesAll(entry.text, terms))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // 명령 이름은 리터럴로 둔다: validate가 "자기 명령만 응답하는 hook"으로 인식하는 조건
    await $.command.register({
      name: 'jump',
      description: '이전에 입력한 프롬프트를 골라 대화의 해당 위치로 이동',
      argumentHint: '[검색어 | 번호]',
      // Claude가 응답 중일 때도 바로 열 수 있게
      immediate: true,
    })
    // 이 mod가 로드되기 전에 그려진 행까지 수집하기 위해 UserMessage 행을 다시 그리게 한다
    prompts.clear()
    $.ui.invalidate('ui.render')

    return next(e)
  })

  // 행을 그대로 그리면서 id와 원문만 수집한다
  on('ui.render', { component: 'UserMessage' }, ($, e, next) => {
    const { text, origin, task, from } = e.props
    const hasSender = task !== undefined || from !== undefined
    if (isTypedPrompt(origin, hasSender) && text.trim() && !isSlashCommand(text)) prompts.set(e.requestId, text)

    return next(e)
  })

  on('command.run', { command: 'jump' }, async ($, e) => {
    // 목록은 열 때 한 번만 계산한다 (검색어 입력마다 대화 전체를 읽지 않도록)
    const [messages, stored] = await Promise.all([
      $.session.messages().catch(() => undefined),
      // 기록 파일을 못 읽으면(경로·grep 실패) 화면에서 수집한 행만 쓴다
      readTranscriptPrompts($).catch(() => []),
    ])
    const candidates = mergeSources(stored, [...prompts])
    // 대화 기록을 읽지 못하면 현재 대화 여부를 가릴 수 없어 후보 순서 그대로 쓴다
    const entries = messages
      ? orderActivePrompts(candidates, messages)
      : candidates.map(([id, text]) => ({ id, text }))

    await update($, listedEntries, () => entries)
    await update($, filter, () => e.args.trim())
    await $.ui.open({ id: PANE, title: PANE_TITLE, focus: true, closeOnEscape: true })

    // 대화 기록과 모델 컨텍스트에 아무것도 남기지 않는다
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const ui = $.ui.resolve(e)
    const { Box, Text, Button } = ui
    const Input = 'Input' in ui ? ui.Input : undefined

    const query = await read($, filter)
    const currentId = await read($, current)
    // 번호는 대화 순서(1 = 가장 오래된 프롬프트)
    const entries = (await read($, listedEntries)).map((entry, index) => ({ ...entry, no: index + 1 }))
    // 가장 최신 프롬프트가 위로
    const matched = selectEntries(entries, query).reverse()
    const listed = matched.slice(0, MAX_LISTED)
    const noWidth = `#${entries.length}`.length
    const labelWidth = Math.max(MIN_LABEL_WIDTH, e.props.bodyColumns - noWidth - ROW_GAP.length - CURRENT_MARK.length)

    // 패널은 닫지 않는다: 닫으면 도킹 폭이 바뀌어 스크롤 위치가 밀리고, 여러 프롬프트를 연달아 오갈 수 있게 하기 위함
    const jump = async (id: MessageId) => {
      // 거부({ deny })와 예외(행이 사라짐, 스크롤 미지원 화면) 모두 패널을 깨지 않고 토스트로 알린다
      const moved = await $.ui
        .scroll({ to: { requestId: id }, block: 'start' })
        .catch((error: unknown) => ({ deny: error instanceof Error ? error.message : String(error) }))
      if (moved.deny) {
        $.ui.toast(`해당 위치로 이동하지 못했어: ${moved.deny}`)
        return
      }
      await update($, current, () => id)
    }

    const summary =
      entries.length === 0
        ? '아직 수집된 프롬프트가 없어.'
        : `${matched.length}/${entries.length}개 · Enter: 이동 · Tab/↑↓: 선택 · Esc: 닫기`

    return (
      <Box flexDirection="column">
        {Input && (
          <Input
            key="filter"
            placeholder="검색어 (공백으로 나누면 모두 포함) 또는 번호"
            value={query}
            autoFocus
            onInput={value => void update($, filter, () => value)}
            onSubmit={() => void (listed[0] && jump(listed[0].id))}
          />
        )}
        <Text dimColor>{summary}</Text>
        {listed.map(entry => {
          const isCurrent = entry.id === currentId
          return (
            <Button key={`p-${entry.id}`} plain onPress={() => void jump(entry.id)}>
              <Text dimColor>{`${isCurrent ? CURRENT_MARK : ' '}${`#${entry.no}`.padStart(noWidth)}`}</Text>
              {ROW_GAP}
              <Text bold={isCurrent}>{truncate(oneLine(entry.text), labelWidth)}</Text>
            </Button>
          )
        })}
        {matched.length > MAX_LISTED && <Text dimColor>{`외 ${matched.length - MAX_LISTED}개 — 검색어로 좁혀줘`}</Text>}
        {entries.length > 0 && matched.length === 0 && <Text dimColor>검색 결과 없음</Text>}
      </Box>
    )
  })
}
