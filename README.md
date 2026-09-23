# Split Settlement Simulator

An interactive concept simulation of **Hybrid Split Settlement**: net settlement for franchise, multi-merchant and platform onseller networks. A split engine sits on top of bank acquiring rails and splits each store's acquirer payout. Royalties and onseller fees are taken out before funds settle, and every party is paid T+1 to its own BSB, so no one holds merchant funds.

Open `index.html` in a browser. There is no build step and nothing to install.

## Sections

- **Simulate**: pick a network preset (QSR, fitness, marketplace or pharmacy), set the fee split rules and trading pattern, then run a trading day. The page animates the flow of funds from store MIDs to the bank acquirer, then to the split engine, then to the store, HQ and onseller accounts. Refunds and chargebacks run clawbacks automatically. Every split reconciles to the cent.
- **Compare models**: the same simulated trading settled three ways: post-facto invoicing, master account pooling and hybrid split settlement. Each model shows time to funds, collection risk, funds held by HQ and admin cost.
- **Settlement outputs**: the four proof-of-concept deliverables. These are the rule mapping table (editable per-store royalty), the T+1 split payout file, the HQ reconciliation statement (both download as CSV) and the pilot config.
- **Business case**: revenue sensitivity levers (new business, backbook uplift, churn reduction) set against ongoing cost, with the TTV × bps sensitivity grid.
- **Roadmap**: discovery, POC, MVP and later stages, with a checklist saved in the browser.

All merchants, MIDs, BSBs and amounts are fictional.
