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

## Loopdesk side (ho gaya — alag patch, Loopdesk hub repo)

Loopdesk hub ka patch `loopdesk-sehat-saathi.patch` (branch `feat/sehat-saathi-tool`) yeh sab karta hai:

1. **Product**: Products & Bundles mein "Sehat Saathi" (AUTO). Kisi custom bundle mein tick karo → hospital apne aap banta hai, lapse pe pause.
2. **Open button + tool switcher**: "Open Sehat Saathi ↗" aur "Urgent flags ↗" (`/api/hub/open/sehat-saathi?page=flags`).
3. **Send**: `POST /api/hub/tools/sehat-saathi/whatsapp/send` — text, template, aur sirf catalog_message interactive. Business ka number, Loopdesk ki STOP list.
4. **Media**: `GET /api/hub/tools/sehat-saathi/whatsapp/media/:mediaId` (`purpose "whatsapp-media"`) — sirf wahi media jo hub ne isi business ke liye Sehat Saathi ko bheja.
5. **Inbound**: hospital (bundle mein SEHAT_SAATHI) ke number pe naya insaan likhe to wo mareez maana jaata hai → Sehat Saathi. Jo pehle se Regulars customer hai wo Regulars mein rehta hai. Poora WhatsApp message (photo, voice note, document) forward hota hai.
6. **Templates**: `sehat_patient_welcome`, `sehat_patient_checkin`, `sehat_family_invite`, `sehat_family_weekly_digest`, `sehat_refill_reminder` — en / hi / pa. Admin → WhatsApp templates → "Submit missing" se Meta ko jaate hain (Meta approve karega, 1–2 din).

Dhyan do: QR se naye mareez ka pehla message hospital ke **apne** WhatsApp number pe aana chahiye (Loopdesk Settings → location ka number). Shared Loopdesk number pe anjaan insaan ka message kisi business se nahi judta.

## Setup

1. Database: `psql $DATABASE_URL -f backend/src/db/migrations/009_loopdesk_hub.sql` (idempotent; `schema.sql` mein already hai).
2. Backend env: `HUB_SECRET`, `HUB_API_URL`, `APP_BASE_URL`.
3. Loopdesk env: `HUB_SECRET_SEHAT_SAATHI` (same value), `SEHAT_SAATHI_API_URL`, `SEHAT_SAATHI_APP_URL`.
4. Test: `DATABASE_URL=… npm run test:hub` (nakli Loopdesk + WayneRing ke saath poora flow, 12 checks).

## Calling (WayneRing)

Loopdesk hospital mein voice check-in **sirf WayneRing se**, aur sirf jab package mein WAYNERING ho. Haath se bane hospital Twilio pe hi rehte hain.

- Env: `WAYNERING_BASE_URL`, `WAYNERING_API_KEY`, `CALL_WEBHOOK_SECRET`, `PUBLIC_BASE_URL`.
- Call: `POST {WAYNERING_BASE_URL}/api/v1/outbound-calls` — mareez ki bhasha, pehla vaakya, aur instructions (dawai/dose ke baare mein koi salah nahi, lakshan bataye to "hospital team contact karegi").
- Nateeja: `POST /api/voice/waynering/webhook`, `x-waynering-signature` = HMAC-SHA256(`CALL_WEBHOOK_SECRET`, raw body). Bina sahi signature 401. `MISSED_DOSE` → flag, `SYMPTOM` ya transcript mein urgent shabd → flag (urgent), call na uthi → WhatsApp check-in.
- Ye wahi contract hai jo Loyvexa use karta hai; WayneRing ke API ke field naam ek baar milaa lena.
