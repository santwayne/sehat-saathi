# Sehat Saathi × Loopdesk (hospital package)

Sehat Saathi ab Loopdesk ka ek package hai, hospitals ke liye. Loyvexa, WayneRing, GMB aur Video Studio jaisa hi contract hai: plan Loopdesk mein bikta aur bill hota hai, hospital Sehat Saathi mein apne aap ban jaata hai, staff Loopdesk se bina password khulta hai, aur WhatsApp hospital ke Loopdesk number se jaata hai.

Haath se bane hospitals (demo, pilot, direct clients) **bilkul pehle jaise** chalte hain: apna WhatsApp number, apna Twilio voice, Super Admin billing.

## Kya hota hai

| Loopdesk mein | Sehat Saathi mein |
| --- | --- |
| Business ko Sehat Saathi wala bundle diya | Hospital banta hai (naam = business ka naam), pehla admin = owner (owner ka phone login phone, agar free hai) |
| Bundle renew / plan badla / tools badle | Wahi hospital update (`hub_business_id` se). Naam/address jo hospital ne set kiya wo nahi badalta |
| Bundle lapse / suspend | Hospital `suspended`: WhatsApp messages ignore, login pe records band, Loopdesk SSO band |
| Payment aayi | Phir `active` |
| "Open Sehat Saathi ↗" | `/sso#token=…` → dashboard seedha khulta hai |
| Package mein WAYNERING | Voice check-in calls allowed. Nahi hai to calls band, check-ins WhatsApp pe hi |
| Plan "without patient records" | `recordsMode: "without_records"` bhejo. Jab tak hospital ke paas records hain, ye badlaav refuse hota hai (warning wapas aati hai) |

Super Admin Loopdesk hospital ka plan ya invoice **nahi** bana sakta (409 `BILLED_IN_LOOPDESK`), taaki double billing na ho.

## Endpoints (Sehat Saathi)

Token: HS256, secret `HUB_SECRET`, `iss "regulars-hub"`, `aud "sehat-saathi"`, `sub` = Loopdesk business id, `jti` ek hi baar chalta hai, 2 minute.

- `POST /api/hub/provision` — Bearer token, `purpose "provision"`. Body:
  ```json
  { "hubBusinessId": "…", "active": true, "plan": "Sehat Saathi Professional — Complete", "paidUntil": "2027-01-31",
    "tools": ["SEHAT_SAATHI", "WAYNERING"], "recordsMode": "with_records",
    "business": { "name": "AIMC Bassi Hospital", "address": "Ludhiana", "phone": "…" },
    "owner": { "name": "Dr …", "email": "…", "phone": "98…" } }
  ```
  Jawab: `{ accountId, status: "ACTIVE"|"PAUSED", data: { name, created, recordsMode, voiceCalls, consoleUrl, warnings? } }`
- `POST /api/hub/sso/exchange` — body `{ token }` (`purpose "sso"`, optional `email`, `next`). Jawab: staff session. Dashboard ka `/sso` page ye khud karta hai.
- `POST /api/hub/whatsapp/inbound` — Bearer token `purpose "whatsapp-inbound"`. Body `{ messages: [ WhatsApp Cloud API message objects ] }` (Meta ka `messages[]` jaisa hai waisa). Turant 200, phir bilkul Meta webhook jaisa handle hota hai (enrolment, family, prescription photo, voice note, urgent flags, STOP).

## Loopdesk side pe kya banana hai (alag PR, hub repo)

Token: `iss "sehat-saathi"`, `aud "regulars-hub"`, `sub` = business id, secret `HUB_SECRET_SEHAT_SAATHI` (Sehat Saathi ke `HUB_SECRET` jaisa).

1. **Provision call**: bundle mein Sehat Saathi ho to upar wali body bhejo (`SEHAT_SAATHI_API_URL/api/hub/provision`), `tools` mein package ke saare tools.
2. **Open button**: `SEHAT_SAATHI_APP_URL/sso#token=<purpose "sso" token>`.
3. **Send**: `POST /api/hub/tools/sehat-saathi/whatsapp/send`, `purpose "whatsapp-send"`, body `{ to, message }` (Cloud API payload: `text`, `template` ya `interactive`). Hospital ke number se bhejo, apni STOP list lagao, jawab `{ messageId }`.
4. **Media**: `GET /api/hub/tools/sehat-saathi/whatsapp/media/:mediaId`, `purpose "whatsapp-media"`. File bytes + `Content-Type` lautao (prescription photos, voice notes Loopdesk ke WABA mein hote hain).
5. **Inbound forward**: hospital ke number pe aaya message jo Sehat Saathi ka hai → `POST SEHAT_SAATHI_API_URL/api/hub/whatsapp/inbound`. Rule: hospital business ke saare mareez/family messages Sehat Saathi ko (QR/bed enrolment code, photos, voice notes bhi), sirf woh nahi jo kisi aur tool ke keyword/flow ke hain.
6. **Templates**: Loopdesk ke Meta account mein ye templates approve karwao (same naam, hi/pa/en): `patient_welcome`, `patient_checkin`, `family_invite`, `family_weekly_digest`, `refill_reminder`. Template na ho to family/refill messages 24 ghante ki window mein plain text pe aa jaate hain; welcome aur check-in ko template chahiye.

## Setup

1. Database: `psql $DATABASE_URL -f backend/src/db/migrations/009_loopdesk_hub.sql` (idempotent; `schema.sql` mein already hai).
2. Backend env: `HUB_SECRET`, `HUB_API_URL`, `APP_BASE_URL`.
3. Loopdesk env: `HUB_SECRET_SEHAT_SAATHI` (same value), `SEHAT_SAATHI_API_URL`, `SEHAT_SAATHI_APP_URL`.
4. Test: `DATABASE_URL=… npm run test:hub` (nakli Loopdesk ke saath poora flow, 10 checks).

## Calling (abhi ki halat)

Package mein WAYNERING ho to voice check-ins chalte hain, lekin abhi bhi Sehat Saathi ke apne Twilio setup se. Bundle rule "calling sirf WayneRing se" poora karne ke liye agla kadam: `voice.service.js` mein Twilio ki jagah WayneRing ka call API (Loyvexa ka `calls/providers.js` jaisa).
