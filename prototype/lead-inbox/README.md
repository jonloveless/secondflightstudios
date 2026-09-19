# SFS mobile lead inbox prototype

This is an isolated, static product-design prototype. It uses six in-memory mock leads, makes no network requests, stores nothing, and sends no email, SMS, or calls.

## Preview

From the repository root:

```sh
python3 -m http.server 4173
```

Then open:

```text
http://localhost:4173/prototype/lead-inbox/
```

Use a 390 × 844 responsive viewport for the intended iPhone-sized experience. The prototype also constrains itself to a phone-sized shell on desktop.

## Interaction walkthrough

1. Open the 47-second-old production lead or the urgent Lake House Inn lead.
2. Read the AI brief without opening the original inquiry.
3. Edit or copy the prepared response.
4. Choose **Approve & send response** to demonstrate a local state change to **Waiting on customer** and capture a mock first-response time. Nothing is sent.
5. Try **Assign**, **Snooze**, **Call**, and **Close**. These controls only change local state or show a confirmation toast.
6. Use the reset icon in the inbox header to restore the original mock data.

No existing production route links to this prototype.
