# Privacy policy (draft)

**Draft for review (S51, 2026-11-04). Not legal advice and not yet in force.** Last updated: [date].

This policy explains what **[Company]** ("Pepper", "we") does with personal information. Pepper is used by appointment-based businesses in the United States.

Two roles matter:
- For **owners, managers and staff** who sign in, Pepper decides what is collected about their accounts.
- For a business's **clients**, the business decides; Pepper handles their details on the business's behalf and only to run Pepper for it (a service provider or processor). A client with a question about their details should ask the business first; we will help it answer.

## 1. What we collect
**Accounts (owners, managers, staff):** name, email, password (stored only as a hash), the two-step verification secret and backup codes, the businesses you belong to and your role, the sessions you are signed in on, and what you do in the app (for example a booking you made), recorded in the business's change history.

**The business:** its name, booking link, time zone, business type, phone, public and mailing addresses, cancellation policy, brand colour, photos, services, prices, team, hours, time off and booking rules.

**Clients (on the business's behalf):** name, email, phone, tags, birthday, appointments and visit history, waitlist requests, unsubscribe choices, and what the business or its assistant has noted about them ("what Pepper knows"). Clients who book on the booking page also give the code they were emailed; if they choose, the device is remembered for 90 days so they can book again without a code (a random token, stored only as a hash).

**Imports:** when a business imports a file from another app, Pepper keeps the rows it needs to show the preview and to undo the import for 7 days, not the file itself.

**Chats with the assistant:** the messages members exchange with Pepper's assistant.

**Technical data:** the IP address and browser for security and rate limits; error reports. The booking page counts how many visitors reach each step without recording who they are.

We do not sell personal information or share it for advertising, and we do not use cookies for advertising or cross-site tracking. The app uses cookies only to keep you signed in and, on the booking page, to remember a device a client chose to remember.

## 2. Why we use it
To run Pepper for the business: bookings, reminders and confirmations, the calendar, client records, the assistant's suggestions and actions, imports and exports; to keep accounts and data secure (two-step verification, rate limits, change history); to answer support requests; to improve Pepper from aggregate, non-identifying usage; and to meet legal duties.

## 3. The AI assistant
Requests to the assistant are processed by an AI model provider (OpenAI) under an agreement that the data is not used to train their models; for the live service we use a zero-data-retention configuration where the provider offers it. Pepper sends the model only what a request needs and leaves contact details (emails, phone numbers) out of what it sends. Development and testing use made-up data only. The assistant never reads or changes the database directly: everything it does goes through the same checks as the app's screens, is recorded with its reason and can be undone where possible.

## 4. Who else handles it (subprocessors)
- Hosting and storage: [hosting provider], in the United States.
- Email delivery: Resend (booking emails, reminders, account emails).
- AI processing: OpenAI.
- Error and performance monitoring: Sentry, Grafana Cloud (no message content).
- Later, when a business turns them on: an SMS provider for text messages, Stripe for deposits and card payments, Google for calendar sync.

Each receives only what it needs to do its job. We may disclose information if the law requires it, to protect people's safety, or as part of a sale or merger of Pepper (with this policy continuing to apply).

## 5. How long we keep it
- Business and client data: for as long as the business uses Pepper, until the business deletes it (§7).
- A deleted client: their details and what Pepper knew about them are removed at once; past visits stay in the business's history as "Deleted client".
- Chats with the assistant: deleted after 90 days.
- Sent emails' delivery records: deleted after 30 days; expired booking requests after 24 hours.
- Import working rows: until the import can no longer be undone (7 days).
- Remembered booking devices: 90 days.
- Backups: kept for [backup retention] and then overwritten.

## 6. Security
Data is encrypted in transit; each business's data is kept apart at the database level, so one business cannot read another's; owners must use two-step verification; access by members follows their role; changes are recorded. No system is perfectly secure; if a breach affects your information, we will tell the businesses concerned without undue delay and as the law requires.

## 7. Your choices and rights
- **Export:** the owner can download all the business's data at any time (More → Your data): clients and visits as spreadsheet files Pepper and other apps can import, and everything else as JSON. Pepper builds the file when asked and keeps no copy.
- **Correct or delete a client:** owners and managers can edit or delete a client in the app.
- **Delete an account or a business:** [S51.2: a grace period during which it can be restored, then the business's data is removed from the live system, and from backups as they roll over].
- **Unsubscribe:** every marketing email has a one-click unsubscribe link.
- **Access, correction and deletion requests:** depending on where you live, you may have rights to know, access, correct, delete or move your personal information. Owners and staff can write to us; clients should ask the business, or write to us and we will pass the request on. We will not treat you differently for exercising these rights.

## 8. Children
Pepper is for businesses and is not directed to children under 13. A business may book a child's appointment through a parent or guardian.

## 9. Changes
We will update this policy as Pepper changes and tell businesses about material changes in the app or by email before they take effect.

## 10. Contact
[Company], [address] · [contact email]
