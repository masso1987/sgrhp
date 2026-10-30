# Stock BTP (chantiers) — module `btp`

Construction stock management, independent from the existing `stock` module (sales / EPI), which is unchanged.

## Activation
- The superadmin enables **Stock BTP (chantiers)** in the company's modules (`PUT /api/tenants/:id/modules`).
- The company ADM grants the `btp` module to users (Utilisateurs › Modules). ADM sees it automatically.

## Data (JSON documents in the `store` table, no schema change)
| Collection | Content |
|---|---|
| `btpCategories` | Material categories (12 BTP defaults created per company) |
| `btpMaterials` | Materials: ref, unit, purchase unit + conversion, thresholds, purchase price, `avgCost` (CUMP), VAT, active |
| `btpWarehouses` | Central / secondary / site / temporary / depot; a chantier gets its own site warehouse |
| `btpProjects` | Chantiers: client, manager, dates, budget, status, `siteWarehouseId` |
| `btpMovements` | **Ledger**: one line per material and warehouse, signed quantity, unit cost, value, chantier, reason, `ref` of the operation |
| `btpRequests` | Material requests with lines (requested / approved), status and history |
| `btpDeliveries` | Delivery notes (BL), linked to a request and to the ledger operation (`movementRef`) |

Every record carries `tenantId`; every read goes through `mine()` and every ID from the client is checked against the caller's company.

## Inventory rules (src/routes/btp.js, `post()`)
- Stock = sum of ledger lines; there is no editable quantity field.
- An operation is validated entirely before anything is written (synchronous, so no interleaving): a transfer or delivery moves everything or nothing.
- Negative stock is refused.
- `clientKey` makes a submission idempotent (double click, network retry).
- Posted movements are never edited or deleted. Corrections: `POST /movements/:ref/reverse` (whole operation, once) or an adjustment with a reason.
- Valuation: weighted average cost, recomputed on each receipt/initial entry; outflows are valued at the current average. A reversal does not recompute past averages.

## API (`/api/btp`, module guard `requireModule("btp")`)
| Endpoint | Roles |
|---|---|
| `GET /meta, /categories, /materials, /warehouses, /projects, /movements, /requests, /deliveries, /dashboard, /export/*.xlsx` | ADM, CD, RJ, GPF, RS |
| `POST/PUT /categories, /materials, /warehouses, /projects`, `POST /movements/:ref/reverse` | ADM, CD, RS |
| `POST /movements` (types: initial, reception, transfert, consommation, retour, retour_fournisseur, ajustement, endommage, perte) | ADM, CD, GPF, RS |
| `POST /requests`, `/requests/:id/submit`, `/requests/:id/cancel` | any BTP user (non-managers see only their own requests) |
| `POST /requests/:id/approve` (per-line approved quantity), `/requests/:id/reject` | ADM, CD |
| `POST /deliveries` (≤ approved − already delivered), `GET /deliveries/:id/pdf` | ADM, CD, GPF, RS / all readers |

Notifications (in-app + email when configured), editable per company in « Modèles de notification »: request submitted → ADM/CD; approved/rejected → requester; delivery done → requester; low stock / out of stock → ADM/CD; purchase order received → ADM/CD.

## Features brought over from the Stock module
| Feature | How it works in BTP |
|---|---|
| Fournisseurs / Clients | Same records as Stock (`stockContacts`, FRN0001 / CLI0001), usable without the Stock module. Supplier balance and statement: opening balance + purchases − payments − return credits. Chantiers can link to a client record. |
| Bons de commande (`btpPOs`) | Draft → sent → partially received → received (or cancelled / closed short). Lines in stock or purchase unit, HT price, discount, VAT; totals computed on the server. **No stock until reception.** |
| Achats & factures (`btpPurchases`) | Every reception (from a PO or direct) is a purchase invoice and posts a `reception` in the ledger. Transport is spread over the lines and included in the stock cost (CUMP); VAT is not. Cannot receive more than ordered. |
| Paiements (`btpPayments`) | From a payment account; never more than the amount due; a cash box cannot go negative; idempotent. A paid purchase cannot be cancelled. |
| Retours fournisseur (`btpSupplierReturns`) | Linked to the original purchase (≤ quantity bought − already returned), posts `retour_fournisseur`, gives a credit (TTC) on the supplier balance. |
| Dépenses (`btpExpenses`, `btpExpenseCats`) | Non-material site costs, optionally paid from an account; added to the chantier cost. |
| Comptes de paiement (`btpAccounts`, `btpAccountEntries`) | Cash box / bank / mobile money; balance and statement from opening balance, supplier payments, expenses and manual entries. |
| Marques (`btpBrands`) | Brand per material. |
| Import | Excel (.xlsx) or CSV (UTF-8, `;` or `,`): column mapping in the browser. Materials: creates missing categories/brands, skips existing references. Opening stock: all-or-nothing, one `initial` operation. |
| Dotation EPI | Issues protective equipment to an HR employee from BTP stock (ledger type `dotation`), counted in the chantier cost. |
| Modèles de notification (`btpNotifTemplates`) | Subject/body with `{{variables}}`, can be disabled or reset to default. |

Chantier cost = consumed + damaged/lost + EPI + expenses (reversed operations excluded).

## Screens
Stock BTP group, by section: Pilotage (Tableau de bord), Catalogue (Matériaux, Catégories, Marques, Import), Sites (Entrepôts, Chantiers, Clients), Stock (Mouvements), Achats (Fournisseurs, Bons de commande, Achats & factures, Retours fournisseur), Chantier (Demandes, Livraisons, Consommations, Dotation EPI), Finances (Dépenses, Comptes de paiement), Rapports, Configuration (Modèles de notification). Welcome tour included.

## Tests
Two end-to-end suites run against an isolated copy (JSON store): 40 checks for the core ledger/requests/deliveries and 45 for suppliers, purchases, payments, returns, expenses, accounts, EPI, templates, imports and company isolation.

## Not included yet
Quotation comparison before ordering, equipment and tool tracking, physical inventory counts, FIFO valuation, attachments/photos on deliveries, sales / quotes / POS for materials.
