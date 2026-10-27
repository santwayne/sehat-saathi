// Supported patient languages and the fixed, safety-critical messages that must
// never depend on the LLM (check-in prompt, urgent escalation, "forwarded to
// your doctor" fallback). Other services (family, refill, enrollment) keep
// their own copy and fall back to English for languages they don't translate.
//
// Marathi/Gujarati/Bengali/Tamil/Telugu strings are first drafts — have a
// native speaker review them before going live with patients.

const LANGUAGES = {
  hi: { name: 'Hindi', azure: 'hi-IN' },
  pa: { name: 'Punjabi', azure: 'pa-IN' },
  en: { name: 'English', azure: 'en-IN' },
  mr: { name: 'Marathi', azure: 'mr-IN' },
  gu: { name: 'Gujarati', azure: 'gu-IN' },
  bn: { name: 'Bengali', azure: 'bn-IN' },
  ta: { name: 'Tamil', azure: 'ta-IN' },
  te: { name: 'Telugu', azure: 'te-IN' },
};

const MESSAGES = {
  // Spoken on a voice check-in call; keys are pressed or spoken, so no "reply".
  checkinVoice: {
    hi: 'नमस्ते! यह आपके क्लिनिक की ओर से चेक-इन कॉल है। क्या आपने आज अपनी दवाइयां समय पर ली हैं? हाँ के लिए 1 दबाएं, नहीं या खुराक छूट गई हो तो 2 दबाएं।',
    pa: 'ਸਤਿ ਸ਼੍ਰੀ ਅਕਾਲ! ਇਹ ਤੁਹਾਡੇ ਕਲਿਨਿਕ ਵੱਲੋਂ ਚੈੱਕ-ਇਨ ਕਾਲ ਹੈ। ਕੀ ਤੁਸੀਂ ਅੱਜ ਆਪਣੀਆਂ ਦਵਾਈਆਂ ਸਮੇਂ ਸਿਰ ਲਈਆਂ ਹਨ? ਹਾਂ ਲਈ 1 ਦਬਾਓ, ਨਹੀਂ ਜਾਂ ਖੁਰਾਕ ਖੁੰਝ ਗਈ ਹੋਵੇ ਤਾਂ 2 ਦਬਾਓ।',
    en: 'Hello! This is a check-in call from your clinic. Did you take your medicines on time today? Press 1 for yes, or press 2 if you missed a dose.',
    mr: 'नमस्कार! हा तुमच्या क्लिनिककडून चेक-इन कॉल आहे. तुम्ही आज तुमची औषधे वेळेवर घेतली का? हो साठी 1 दाबा, नाही किंवा डोस चुकला असल्यास 2 दाबा.',
    gu: 'નમસ્તે! આ તમારા ક્લિનિક તરફથી ચેક-ઇન કૉલ છે. શું તમે આજે તમારી દવાઓ સમયસર લીધી? હા માટે 1 દબાવો, ના અથવા ડોઝ ચૂકી ગયા હો તો 2 દબાવો.',
    bn: 'নমস্কার! এটি আপনার ক্লিনিকের চেক-ইন কল। আপনি কি আজ সময়মতো ওষুধ খেয়েছেন? হ্যাঁ হলে 1 চাপুন, না বা ডোজ মিস হলে 2 চাপুন।',
    ta: 'வணக்கம்! இது உங்கள் கிளினிக்கிலிருந்து வரும் செக்-இன் அழைப்பு. இன்று மருந்துகளை நேரத்திற்கு எடுத்துக்கொண்டீர்களா? ஆம் என்றால் 1ஐ அழுத்தவும், இல்லை அல்லது டோஸ் தவறினால் 2ஐ அழுத்தவும்.',
    te: 'నమస్కారం! ఇది మీ క్లినిక్ నుండి చెక్-ఇన్ కాల్. మీరు ఈరోజు మందులను సమయానికి తీసుకున్నారా? అవును అయితే 1 నొక్కండి, లేదు లేదా డోస్ మిస్ అయితే 2 నొక్కండి.',
  },
  voiceThanks: {
    hi: 'धन्यवाद। आपका जवाब क्लिनिक को भेज दिया गया है। अपना ध्यान रखिए।',
    pa: 'ਧੰਨਵਾਦ। ਤੁਹਾਡਾ ਜਵਾਬ ਕਲਿਨਿਕ ਨੂੰ ਭੇਜ ਦਿੱਤਾ ਗਿਆ ਹੈ। ਆਪਣਾ ਖ਼ਿਆਲ ਰੱਖੋ।',
    en: 'Thank you. Your response has been shared with the clinic. Take care.',
    mr: 'धन्यवाद. तुमचे उत्तर क्लिनिकला कळवले आहे. काळजी घ्या.',
    gu: 'આભાર. તમારો જવાબ ક્લિનિકને મોકલવામાં આવ્યો છે. કાળજી રાખજો.',
    bn: 'ধন্যবাদ। আপনার উত্তর ক্লিনিককে জানানো হয়েছে। নিজের যত্ন নিন।',
    ta: 'நன்றி. உங்கள் பதில் கிளினிக்குக்கு தெரிவிக்கப்பட்டது. உடல்நலத்தைப் பார்த்துக்கொள்ளுங்கள்.',
    te: 'ధన్యవాదాలు. మీ సమాధానం క్లినిక్‌కు తెలియజేయబడింది. జాగ్రత్తగా ఉండండి.',
  },
  checkin: {
    hi: 'नमस्ते! यह आपके क्लिनिक से चेक-इन है। क्या आपने आज अपनी दवाइयां समय पर ली हैं? उत्तर दें: 1 (हाँ), 2 (नहीं/खुराक छूट गई)।',
    pa: 'ਸਤਿ ਸ਼੍ਰੀ ਅਕਾਲ! ਇਹ ਤੁਹਾਡੇ ਕਲਿਨਿਕ ਤੋਂ ਚੈੱਕ-ਇਨ ਹੈ। ਕੀ ਤੁਸੀਂ ਅੱਜ ਆਪਣੀਆਂ ਦਵਾਈਆਂ ਸਮੇਂ ਸਿਰ ਲਈਆਂ ਹਨ? ਜਵਾਬ ਦਿਓ: 1 (ਹਾਂ), 2 (ਨਹੀਂ)।',
    en: 'Hello! This is a check-in from your clinic. Did you take your prescribed medicines today on time? Reply: 1 (Yes), 2 (No/Missed dose).',
    mr: 'नमस्कार! हा तुमच्या क्लिनिककडून चेक-इन आहे. तुम्ही आज तुमची औषधे वेळेवर घेतली का? उत्तर द्या: 1 (हो), 2 (नाही/डोस चुकला).',
    gu: 'નમસ્તે! આ તમારા ક્લિનિક તરફથી ચેક-ઇન છે. શું તમે આજે તમારી દવાઓ સમયસર લીધી? જવાબ આપો: 1 (હા), 2 (ના/ડોઝ ચૂકી ગયો).',
    bn: 'নমস্কার! এটি আপনার ক্লিনিকের চেক-ইন। আপনি কি আজ সময়মতো আপনার ওষুধ খেয়েছেন? উত্তর দিন: 1 (হ্যাঁ), 2 (না/ডোজ মিস হয়েছে)।',
    ta: 'வணக்கம்! இது உங்கள் கிளினிக்கிலிருந்து வரும் செக்-இன். இன்று உங்கள் மருந்துகளை நேரத்திற்கு எடுத்துக்கொண்டீர்களா? பதிலளிக்கவும்: 1 (ஆம்), 2 (இல்லை/டோஸ் தவறியது).',
    te: 'నమస్కారం! ఇది మీ క్లినిక్ నుండి చెక్-ఇన్. మీరు ఈరోజు మీ మందులను సమయానికి తీసుకున్నారా? సమాధానం ఇవ్వండి: 1 (అవును), 2 (లేదు/డోస్ మిస్ అయింది).',
  },
  urgent: {
    hi: 'आपका संदेश क्लिनिक टीम को भेज दिया गया है। यदि यह आपातकालीन स्थिति है, तो कृपया तुरंत क्लिनिक से संपर्क करें।',
    pa: 'ਤੁਹਾਡਾ ਸੁਨੇਹਾ ਕਲਿਨਿਕ ਦੀ ਟੀਮ ਨੂੰ ਭੇਜ ਦਿੱਤਾ ਗਿਆ ਹੈ। ਜੇਕਰ ਇਹ ਇਮਰਜੈਂਸੀ ਹੈ, ਤਾਂ ਕਿਰਪਾ ਕਰਕੇ ਤੁਰੰਤ ਕਲਿਨਿਕ ਨਾਲ ਸੰਪਰਕ ਕਰੋ।',
    en: 'Your message has been escalated to the clinic team. If this is an emergency, please contact the clinic immediately.',
    mr: 'तुमचा संदेश क्लिनिक टीमला पाठवला आहे. ही आणीबाणी असल्यास कृपया त्वरित क्लिनिकशी संपर्क साधा.',
    gu: 'તમારો સંદેશ ક્લિનિક ટીમને મોકલવામાં આવ્યો છે. જો આ કટોકટી હોય, તો કૃપા કરીને તરત જ ક્લિનિકનો સંપર્ક કરો.',
    bn: 'আপনার বার্তা ক্লিনিক টিমকে পাঠানো হয়েছে। এটি জরুরি হলে অনুগ্রহ করে এখনই ক্লিনিকের সঙ্গে যোগাযোগ করুন।',
    ta: 'உங்கள் செய்தி கிளினிக் குழுவுக்கு அனுப்பப்பட்டுள்ளது. இது அவசரநிலை என்றால் உடனடியாக கிளினிக்கைத் தொடர்பு கொள்ளவும்.',
    te: 'మీ సందేశం క్లినిక్ బృందానికి పంపబడింది. ఇది అత్యవసరమైతే, దయచేసి వెంటనే క్లినిక్‌ను సంప్రదించండి.',
  },
  forwarded: {
    hi: 'मैंने यह प्रश्न आपके क्लिनिक डॉक्टर को भेज दिया है। वे जल्द ही आपसे संपर्क करेंगे।',
    pa: 'ਮੈਂ ਇਹ ਜਾਣਕਾਰੀ ਤੁਹਾਡੇ ਕਲਿਨਿਕ ਦੇ ਡਾਕਟਰ ਨਾਲ ਸਾਂਝੀ ਕਰ ਦਿੱਤੀ ਹੈ। ਉਹ ਜਲਦੀ ਹੀ ਤੁਹਾਡੇ ਨਾਲ ਸੰਪਰਕ ਕਰਨਗੇ।',
    en: 'I have forwarded this question to your clinic doctor. They will respond to you shortly.',
    mr: 'मी हा प्रश्न तुमच्या क्लिनिकच्या डॉक्टरांना पाठवला आहे. ते लवकरच तुमच्याशी संपर्क साधतील.',
    gu: 'મેં આ પ્રશ્ન તમારા ક્લિનિકના ડૉક્ટરને મોકલ્યો છે. તેઓ ટૂંક સમયમાં તમારો સંપર્ક કરશે.',
    bn: 'আমি এই প্রশ্নটি আপনার ক্লিনিকের ডাক্তারকে পাঠিয়েছি। তিনি শীঘ্রই আপনার সঙ্গে যোগাযোগ করবেন।',
    ta: 'இந்தக் கேள்வியை உங்கள் கிளினிக் மருத்துவருக்கு அனுப்பியுள்ளேன். அவர் விரைவில் உங்களைத் தொடர்பு கொள்வார்.',
    te: 'ఈ ప్రశ్నను మీ క్లినిక్ డాక్టర్‌కు పంపాను. వారు త్వరలో మిమ్మల్ని సంప్రదిస్తారు.',
  },
};

function isSupportedLanguage(code) {
  return Object.prototype.hasOwnProperty.call(LANGUAGES, code);
}

/** Fixed message for `key` in `lang`; unknown/missing language falls back to English. */
function t(key, lang) {
  const group = MESSAGES[key];
  return group[isSupportedLanguage(lang) ? lang : 'en'];
}

function languageName(code) {
  return isSupportedLanguage(code) ? LANGUAGES[code].name : code;
}

// The conversation engine also logs its own replies with intent
// 'checkin_response', so that intent alone can't identify a scheduled check-in
// prompt. Reports match on the prompt text instead (direct sends log the
// localized text; the BullMQ worker logs a "patient_checkin template sent" line).
const CHECKIN_PROMPT_TEXTS = Object.values(MESSAGES.checkin);
const CHECKIN_TEMPLATE_LOG_PATTERN = 'patient_checkin template sent%';
// Voice check-in calls log their prompt with this prefix.
const VOICE_CHECKIN_LOG_PREFIX = '[Voice check-in] ';

module.exports = { LANGUAGES, isSupportedLanguage, t, languageName, CHECKIN_PROMPT_TEXTS, CHECKIN_TEMPLATE_LOG_PATTERN, VOICE_CHECKIN_LOG_PREFIX };
