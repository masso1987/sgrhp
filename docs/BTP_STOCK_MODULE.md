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

Notifications (in-app + email when configured): request submitted → ADM/CD; approved/rejected → requester; low stock / out of stock → ADM/CD.

## Screens
Stock BTP group: Tableau de bord BTP, Matériaux, Catégories, Entrepôts, Chantiers (+ chantier detail), Mouvements de stock, Demandes de matériel, Livraisons, Consommations, Rapports. Welcome tour included.

## Not included yet
Purchase requests with quotation comparison (BTP-specific purchase orders), equipment and tool tracking, physical inventory counts, FIFO valuation, attachments/photos on deliveries.
