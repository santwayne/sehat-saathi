/**
 * Code-level safety rules. These never depend on the LLM.
 *
 * Sehat Saathi is Hindi/Punjabi-first, so every rule covers English, Hinglish
 * (Roman Hindi), Hindi (Devanagari), Roman Punjabi and Punjabi (Gurmukhi).
 * A false positive costs one escalation to staff; a false negative can cost a
 * patient — so the lists lean towards catching more.
 */

// Text is lowercased and its whitespace collapsed before matching, so
// "Chhati   mein DARD" and "chhati mein dard" are the same.
const normalize = (text) => String(text || '').toLowerCase().replace(/\s+/g, ' ').trim();

// ---------------------------------------------------------------------------
// 1. Directives the AI must never send (any language). A hit routes the reply
//    to escalation instead of the patient (conversation.service.js).
// ---------------------------------------------------------------------------
const BANNED_PATTERNS = [
  // English
  /stop (taking|your) (medicine|medication|pills|tablets?|dosage)/i,
  /(increase|decrease|reduce|double|change) (your|the) (dose|dosage)/i,
  /you can take/i,
  /don'?t take/i,
  /do not take/i,
  /skip the/i,
  /substitute/i,
  // Hinglish / Roman Hindi: "dawai band karo", "goli mat lo", "dose badha do", "dawai chhod do"
  /(dawai|dawa|davai|dava|goli|golian|goliyan|tablet|medicine|dose)\s*(ko\s*)?(band|bandh)\s*(kar|kardo|kar do|karo|kar dein|kar dijiye)/i,
  /(dawai|dawa|davai|dava|goli|golian|goliyan|tablet|medicine)\s*(mat|na|nahi|nahin)\s*(lo|lein|khao|khayein|khana|lena)/i,
  /(dawai|dawa|davai|dava|goli|golian|goliyan|tablet|medicine)\s*(ko\s*)?(chhod|chod)\s*(do|dein|dijiye)/i,
  /(dose|khurak|matra)\s*(ko\s*)?(badha|badhao|badhaa|ghata|ghatao|kam|zyada|jyada|double)\s*(kar|kardo|kar do|karo|do|dein|lo)?/i,
  /(dusri|doosri|koi aur|dusra|doosra)\s*(dawai|dawa|goli|tablet|medicine)\s*(le|lo|lein|khao)/i,
  // Hindi (Devanagari)
  /(दवा|दवाई|दवाइयाँ|गोली|गोलियाँ|टैबलेट)\s*(को\s*)?(बंद|बन्द)\s*(कर|करें|करो|कर दें|कर दो)/,
  /(दवा|दवाई|गोली|गोलियाँ|टैबलेट)\s*(मत|ना|न|नहीं)\s*(लें|लो|खाएं|खाओ|खाएँ)/,
  /(दवा|दवाई|गोली)\s*(को\s*)?छोड़\s*(दें|दो|दीजिए)/,
  /(खुराक|डोज़|डोज)\s*(को\s*)?(बढ़ा|बढ़ाएं|बढ़ाओ|घटा|घटाएं|घटाओ|कम|ज़्यादा|दोगुनी)/,
  /(दूसरी|कोई और)\s*(दवा|दवाई|गोली)\s*(लें|लो|खाएं)/,
  // Roman Punjabi: "dawai band kar dao", "goli na khao", "dose vadha deo"
  /(dawai|dawa|goli|golian|tablet)\s*(nu\s*)?(band|bandh)\s*(kar|karo|kardo|kar dao|kar deo)/i,
  /(dose|khurak)\s*(nu\s*)?(vadha|vadhao|ghata|ghatao|ghat|vadh)\s*(do|dao|deo|karo)?/i,
  // Punjabi (Gurmukhi)
  /(ਦਵਾਈ|ਦਵਾ|ਗੋਲੀ|ਗੋਲੀਆਂ)\s*(ਨੂੰ\s*)?(ਬੰਦ)\s*(ਕਰ|ਕਰੋ|ਕਰ ਦਿਓ|ਕਰ ਦਓ)/,
  /(ਦਵਾਈ|ਦਵਾ|ਗੋਲੀ|ਗੋਲੀਆਂ)\s*(ਨਾ|ਨਹੀਂ|ਮਤ)\s*(ਲਓ|ਖਾਓ|ਲਵੋ)/,
  /(ਖੁਰਾਕ|ਡੋਜ਼)\s*(ਨੂੰ\s*)?(ਵਧਾ|ਵਧਾਓ|ਘਟਾ|ਘਟਾਓ|ਘੱਟ)/,
];

// ---------------------------------------------------------------------------
// 2. Symptoms a patient (or family member) writes that must go to staff as
//    URGENT straight away, before any AI is involved.
// ---------------------------------------------------------------------------
const URGENT_KEYWORDS = [
  // English
  'chest pain', 'breathing difficulty', 'difficulty breathing', 'breathless', 'shortness of breath', 'cant breathe', "can't breathe",
  'bleeding', 'fainted', 'fainting', 'unconscious', 'severe pain', 'dizziness', 'seizure', 'having fits', 'got fits', 'stroke', 'paralysis',
  'vomiting blood', 'blood in vomit', 'blood in stool', 'black stool', 'heart attack', 'swelling in face', 'swollen tongue', 'allergic reaction',
  'high fever', 'suicide', 'overdose',
  // Hinglish / Roman Hindi
  'chhati me dard', 'chhati mein dard', 'chati me dard', 'chati mein dard', 'chhati dard', 'seene me dard', 'seene mein dard', 'sine me dard', 'dil me dard', 'dil mein dard',
  'saans nahi', 'saans nahin', 'sans nahi', 'saans lene me', 'saans lene mein', 'saans phool', 'sans phool', 'saans ruk', 'dam ghut', 'saans ki takleef', 'saans ki dikkat',
  'khoon aa', 'khoon nikal', 'khoon beh', 'khun aa', 'khun nikal', 'ulti me khoon', 'ulti mein khoon', 'potty me khoon', 'latrine me khoon',
  'behosh', 'behoshi', 'behos', 'hosh nahi', 'hosh nahin', 'gir gaye', 'gir gayi', 'gir gaya',
  'bahut tez dard', 'bahut zyada dard', 'bahut jyada dard', 'asahniya dard', 'tez dard', 'sehan nahi',
  'chakkar', 'chakar', 'daura pad', 'daure pad', 'dora pad', 'jhatke', 'muh tedha', 'munh tedha', 'lakwa', 'haath sunn', 'pair sunn',
  'tez bukhar', 'bahut bukhar', 'sujan', 'soojan', 'jeebh sooj', 'hoth sooj', 'zyada goli kha', 'jyada goli kha', 'saari goli kha',
  'marna chahta', 'marna chahti', 'jaan dena', 'khudkushi',
  // Hindi (Devanagari)
  'छाती में दर्द', 'छाती दर्द', 'सीने में दर्द', 'सीने में जलन और दर्द', 'दिल में दर्द',
  'सांस नहीं', 'साँस नहीं', 'सांस लेने में', 'साँस लेने में', 'सांस फूल', 'साँस फूल', 'दम घुट',
  'खून आ', 'खून निकल', 'खून बह', 'उल्टी में खून', 'बेहोश', 'होश नहीं', 'गिर गए', 'गिर गई',
  'बहुत तेज दर्द', 'बहुत तेज़ दर्द', 'असहनीय दर्द', 'चक्कर', 'दौरा पड़', 'दौरे पड़', 'झटके', 'लकवा', 'मुंह टेढ़ा',
  'तेज बुखार', 'तेज़ बुखार', 'सूजन', 'ज़्यादा गोली', 'आत्महत्या', 'मरना चाहता', 'मरना चाहती',
  // Roman Punjabi
  'chhati vich dard', 'chati vich dard', 'seene vich dard', 'saah nahi', 'saah nahin', 'saah lain vich', 'saah chadh', 'sah chadh',
  'khoon aa reha', 'khoon nikal reha', 'behosh ho', 'bohat tez dard', 'bahut tez peed', 'chakkar aa', 'tez bukhar',
  // Punjabi (Gurmukhi)
  'ਛਾਤੀ ਵਿੱਚ ਦਰਦ', 'ਛਾਤੀ ਵਿਚ ਦਰਦ', 'ਛਾਤੀ ਦਰਦ', 'ਸੀਨੇ ਵਿੱਚ ਦਰਦ', 'ਸਾਹ ਨਹੀਂ', 'ਸਾਹ ਲੈਣ ਵਿੱਚ', 'ਸਾਹ ਚੜ੍ਹ', 'ਸਾਹ ਫੁੱਲ',
  'ਖੂਨ ਆ', 'ਖੂਨ ਨਿਕਲ', 'ਬੇਹੋਸ਼', 'ਬਹੁਤ ਤੇਜ਼ ਦਰਦ', 'ਚੱਕਰ', 'ਦੌਰਾ ਪ', 'ਲਕਵਾ', 'ਤੇਜ਼ ਬੁਖਾਰ', 'ਸੋਜ',
].map(normalize);

/**
 * Validates generated message against safety rules.
 * @param {string} text
 * @returns {{ safe: boolean, reason?: string }}
 */
function validateLLMOutput(text) {
  const t = normalize(text);
  for (const pattern of BANNED_PATTERNS) {
    if (pattern.test(t)) {
      return { safe: false, reason: `Output contained restricted medical action phrase matching: ${pattern}` };
    }
  }
  return { safe: true };
}

/**
 * Checks if a patient/family message contains an urgent symptom, in any of
 * the supported languages and scripts.
 * @param {string} text
 * @returns {boolean}
 */
function isUrgentKeywordPresent(text) {
  const t = normalize(text);
  return URGENT_KEYWORDS.some((keyword) => t.includes(keyword));
}

module.exports = { validateLLMOutput, isUrgentKeywordPresent, URGENT_KEYWORDS, BANNED_PATTERNS };
