// KAIROS assistant mode stub — external builds don't support assistant mode,
// but the module shape must exist for the bundler to resolve conditional imports.

let forced = false

export function isAssistantMode() {
  return false
}

export function markAssistantForced() {
  forced = true
}

export function isAssistantForced() {
  return forced
}

export async function initializeAssistantTeam() {
  return undefined
}

export function getAssistantSystemPromptAddendum() {
  return ''
}

export function getAssistantActivationPath() {
  return undefined
}
