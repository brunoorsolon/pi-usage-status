# pi-usage-status

Pi extension that renders the active provider's quota in the footer.

Supported providers:

- **OpenAI Codex** (subscription) — 5h and weekly windows; Pro Lite plans that
  expose a single seven-day `primary_window` are labeled `7d`.
- **Kimi Coding** (OAuth) — 5h window and overall quota. Resolves headers-only
  OAuth Bearer tokens, which is where other quota extensions fail for Kimi.

Percentages are usage **consumed** (provider web UIs may show remaining).

## Install

```bash
pi install npm:pi-sandbox-usage-status
```

Then surface it in your footer. With `pi-powerline-footer`:

```json
{
  "powerline": {
    "layout": { "secondary": ["custom:quotas"] },
    "customItems": [
      { "id": "quotas", "statusKey": "usage-bars", "position": "secondary" }
    ]
  }
}
```

The extension sets status key `usage-bars`, follows the active model's
provider, and polls every 2 minutes. Providers without configured auth clear
the item.

## Test

```bash
npm test
```
