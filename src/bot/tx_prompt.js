// Shared in-memory store for the "awaiting transaction ID" prompt state.
// Keeping this in its own module breaks the circular import between
// handlers.js (which arms the prompt) and wallet.js (which also needs to arm it).

const txPromptMap = new Map();

export function setTxPrompt(userId, orderId) {
  txPromptMap.set(String(userId), orderId);
}

export function getTxPrompt(userId) {
  return txPromptMap.get(String(userId));
}

export function clearTxPrompt(userId) {
  txPromptMap.delete(String(userId));
}
