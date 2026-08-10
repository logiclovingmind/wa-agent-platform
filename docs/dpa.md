# Data Processing Agreement

**DRAFT for legal review — not legal advice.** This is a template for the consultant's
own use. Both parties' full legal names, the governing-law clause, and Schedule A must
be completed by counsel before signature. Facts stated here (retention, sub-processors,
security) are current as of 2026-08-11 and must be kept in step with the code — see the
note in §12.

---

## 1. Parties and role

Between:

- **Data Fiduciary**: **[Client legal entity]** of **[address]** ("Fiduciary"); and
- **Data Processor**: **[Consultant/Platform legal entity]** of **[address]**
  ("Processor").

The Fiduciary operates a WhatsApp-based customer service channel (the "Service"). The
Processor supplies and operates the software platform that receives, stores, and
responds to WhatsApp messages on the Fiduciary's instructions ("Platform").

Under the Digital Personal Data Protection Act, 2023 (India) ("DPDP Act"), the Fiduciary
determines the purposes and means of processing and is a **Data Fiduciary**; the
Processor processes personal data only on the Fiduciary's behalf and is a **Data
Processor**. This Agreement governs that processing.

## 2. Scope of processing

Processing under this Agreement is set out in **Schedule B** and consists of receiving
the Fiduciary's customers' WhatsApp messages, storing them, generating and delivering
automated replies (including via an LLM), and making conversation records available to
the Fiduciary through a dashboard. The Processor may not process personal data for its
own purposes or use it to contact data principals directly.

## 3. Processor obligations

The Processor shall:

1. process personal data only on the Fiduciary's documented instructions, including the
   sector rules and knowledge base the Fiduciary supplies;
2. ensure persons authorised to process personal data are bound by confidentiality;
3. implement and maintain the security measures in **Schedule C**;
4. take reasonable steps to ensure personal data is accurate and complete in light of
   the Fiduciary's instructions;
5. maintain records of processing activities as required under the DPDP Act; and
6. assist the Fiduciary in responding to requests from data principals exercising
   rights under the DPDP Act (access, correction, erasure, grievance), where the
   Processor is technically able to do so.

## 4. Sub-processors

The Fiduciary consents to the Processor engaging the sub-processors in **Schedule A**.
Any addition or replacement of a sub-processor shall be notified to the Fiduciary at
least **[30]** days in advance and shall take effect only if the Fiduciary does not
object. Each sub-processor shall be bound by terms substantially similar to this
Agreement.

The **LLM Provider** is a sub-processor of particular note: **message content is
transmitted outside India to the LLM Provider on every customer message** for the
purpose of generating a reply. This is a deliberate and necessary part of the Service.

## 5. Cross-border transfer

Processing of message content by the LLM Provider involves transfer of personal data
outside India (to the jurisdiction listed in Schedule A). The parties acknowledge that
such transfer is permitted under Section 16 of the DPDP Act, subject to any
restricted-territory notification issued by the Central Government. The Fiduciary is
responsible for the notices and consent required from data principals under Sections 5
and 6 of the DPDP Act, including informing them that their messages are processed
outside India.

## 6. Children's data

The Service may incidentally receive messages from persons under 18. The Processor has
implemented automated detection of such persons and, on detection, stops the automated
agent and hands the conversation to a human for the Fiduciary to involve a parent or
guardian. **The Fiduciary remains responsible for obtaining verifiable parental consent
as required by Section 9 of the DPDP Act for any child whose data is processed.** The
parties shall review this clause when the DPDP Rules are notified.

## 7. Data security and confidentiality

The Processor shall implement and maintain the measures in **Schedule C**, including
encryption in transit, encryption of stored client credentials, tenant isolation at the
database layer, and access limited to authorised personnel. The Processor shall
immediately notify the Fiduciary on becoming aware of any accidental or unauthorised
processing or disclosure.

## 8. Data breach

The Processor shall notify the Fiduciary without undue delay (and in any event within
**[48]** hours) of becoming aware of a breach affecting personal data processed under
this Agreement, providing the Fiduciary sufficient information to assess the impact.
The Fiduciary, as Data Fiduciary, is responsible for notifying the Data Protection Board
and affected data principals as required by Section 8(6) of the DPDP Act; the Processor
shall cooperate with and assist that notification.

## 9. Deletion and retention

The Processor applies automated retention and deletion:

- **Message content in a conversation flagged as involving a minor or distress is
  deleted (scrubbed) within 24 hours.** Record identifiers and timestamps are retained
  to evidence that the system responded correctly.
- **All other message content is deleted 12 months after receipt.**

On termination of this Agreement, or on the Fiduciary's written instruction, the
Processor shall delete or return all personal data within **[30]** days, subject to the
retention obligations above and any legal requirement to retain records.

## 10. Audits

The Fiduciary may, not more than once per year and on reasonable notice, audit the
Processor's compliance with this Agreement. The Processor shall cooperate, subject to
confidentiality and to not exposing other clients' data (the Platform is multi-tenant;
audits are limited to the Fiduciary's own data and to the Processor's general controls).

## 11. Liability

Each party is liable for loss arising from its own breach of this Agreement or from
processing outside the documented instructions. The Processor is not liable for loss
arising from the Fiduciary's instructions. [Consider whether an aggregate cap and
exclusions are appropriate — commercial point for negotiation.]

## 12. Term and changes

This Agreement takes effect on signature and continues for the term of the Service.
Changes to the facts recorded here — particularly retention periods, the LLM Provider,
or the security measures — must be reflected by amending this Agreement, and the
Processor shall keep Schedule A and Schedule C current as those facts change. **The
clauses above state what the Platform does; counsel should verify the clauses match the
deployed code (see `docs/`, `.claude/rules/safety.md`, `.claude/rules/data-model.md`).**

## 13. General

This Agreement is governed by the laws of India and the courts of **[jurisdiction]** have
exclusive jurisdiction. Neither party may assign this Agreement without the other's
consent. If any clause is unenforceable, the remainder continues in force.

---

## Schedule A — Sub-processors

| Provider | Service | Data processed | Location | Cross-border |
|---|---|---|---|---|
| **[LLM Provider, currently OpenAI (gpt-4o-mini)]** | Message inference / reply generation | WhatsApp message text | **[US — update to the provider's hosting region]** | **Yes — message content leaves India on every call** |
| **[Cloudflare]** | Edge hosting, Workers | Encrypted traffic in transit | **[update]** | Yes |
| **[Supabase]** | Postgres database hosting, auth, realtime, media object storage | Stored message records, conversation data, customer-sent images and voice notes | **[update]** | Yes |
| **[GitHub]** | Nightly database backup artifacts | A full copy of the stored message records | **[update]** | Yes |

> Complete the bracketed provider names and locations; add or remove rows to match the
> live platform. The LLM Provider row is mandatory — see §4.

## Schedule B — Processing details

- **Categories of data principal**: the Fiduciary's customers contacting it on WhatsApp.
- **Personal data**: WhatsApp message text, the customer's WhatsApp number, media
  shared by the customer, and derived flags (e.g. minor/distress detection).
- **Purpose**: customer service and booking conversations via the automated agent, with
  human handoff on request or on safety flags.
- **Processing locations**: Cloudflare edge; sub-processor hosting (Schedule A).
- **Retention**: message content scrubbed within 24h for flagged conversations; other
  message content deleted after 12 months; records as described in §9.

## Schedule C — Security measures

- Transport encryption (TLS) on all platform traffic.
- Tenant isolation enforced by per-client row-level security and application-level
  filtering of every query by client (`org_id`).
- Client WhatsApp credentials stored encrypted (AES-GCM) with a rotating key; never
  exposed to the browser or logged.
- Access to production data limited to authorised operators; multi-factor
  authentication for provider accounts.
- Automated nightly encrypted backups to object storage, with restore testing.
- Safety classification of message content (minor/distress) with automatic deletion of
  flagged content within 24 hours.

---

**SIGNATURES**

Data Fiduciary: ______________________  Date: ________

Data Processor: ______________________  Date: ________
