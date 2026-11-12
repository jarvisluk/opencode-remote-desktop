export const REMOTE_INPUT_KINDS = [
  "click",
  "double_click",
  "right_click",
  "scroll",
  "type",
  "key",
] as const

export type RemoteInputKind = (typeof REMOTE_INPUT_KINDS)[number]
