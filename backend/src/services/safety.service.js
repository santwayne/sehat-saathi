// Banned phrasing or directives that the LLM must never output
const BANNED_PATTERNS = [
  /stop (taking|your) (medicine|medication|pills|dosage)/i,
  /increase (your|the) (dose|dosage)/i,
  /decrease (your|the) (dose|dosage)/i,
  /change (your|the) (dose|dosage)/i,
  /you can take/i,
  /don't take/i,
  /do not take/i,
  /skip the/i,
  /substitute/i
];

// High-risk keywords for auto-escalation priority to Urgent
const URGENT_KEYWORDS = [
  'chest pain',
  'breathing difficulty',
  'breathless',
  'shortness of breath',
  'bleeding',
  'fainted',
  'fainting',
  'unconscious',
  'severe pain',
  'dizziness'
];

/**
 * Validates generated message against safety rules.
 * @param {string} text
 * @returns {{ safe: boolean, reason?: string }}
 */
function validateLLMOutput(text) {
  for (const pattern of BANNED_PATTERNS) {
    if (pattern.test(text)) {
      return {
        safe: false,
        reason: `Output contained restricted medical action phrase matching: ${pattern}`
      };
    }
  }
  return { safe: true };
}

/**
 * Checks if user message contains urgent symptom keywords
 * @param {string} text
 * @returns {boolean}
 */
function isUrgentKeywordPresent(text) {
  const lower = text.toLowerCase();
  return URGENT_KEYWORDS.some(keyword => lower.includes(keyword));
}

module.exports = {
  validateLLMOutput,
  isUrgentKeywordPresent
};
