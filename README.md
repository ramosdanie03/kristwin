# Kristwin Consumer Goods Trading — BI System

Sales, Inventory, and Procurement Monitoring system with a Business Intelligence dashboard,
based on the BI dashboard prototype in the BSIS 4-A project paper.

**Stack:** HTML · CSS · JavaScript only — no server needed. It runs on GitHub Pages, or by
opening `index.html` directly in a browser.

## How it works

The original PHP + MySQL backend has been rewritten in JavaScript (`assets/js/backend.js`).
It keeps the same rules (validation, stock updates, purchase-order status flow, admin-only actions),
but the data is saved in the **browser's localStorage** instead of a MySQL database:

- Every visitor starts with the same sample data.
- Changes (new sales, products, purchase orders…) are saved only in that visitor's browser.
- **Reset demo data** on the login page restores the sample data.

| Username | Password | Role |
|---|---|---|
| admin | admin123 | Administrator (owner) — full access, can delete records and manage users |
| staff | staff123 | Staff — can record sales, products, suppliers and purchase orders |

## Publish on GitHub Pages

1. Push this folder to a GitHub repository.
2. On GitHub: **Settings → Pages → Build and deployment → Source: Deploy from a branch**,
   choose branch `main` and folder `/ (root)`, then **Save**.
3. After a minute the site is live at `https://<username>.github.io/<repository>/`.

## Modules

| Module | What it does |
|---|---|
| **Dashboard** | KPI cards (total, average, highest and lowest month), monthly sales bar chart with peak months, sales-by-product donut, Inventory Status, Procurement Summary and Low-Performing Products. Year selector and Print. |
| **Sales** | Record sales (date, product, qty, price, discount, customer, In-store/Messenger). Stock is deducted automatically; admins can void a sale, which returns the stock. Filters and CSV export. |
| **Inventory** | Product list. Status is automatic: *In Stock*, *Reorder Soon* (within 10% of reorder level), *Low Stock* (below reorder level), *Out of Stock*. |
| **Procurement** | Purchase orders with line items. Pending → In Progress → Delivered (or Cancelled). Marking *Delivered* adds the quantities to stock. |
| **Suppliers** | Central supplier contact list (replaces scattered Messenger threads). |
| **Users** | Admin-only account management. |

## Dashboard rules

- **Peak months** = the two highest-selling months of the selected year.
- **Sales by Product** = top 5 products; the rest are grouped as *Other Products*.
- **Low-Performing Products** = the 4 lowest-selling products. *Low Demand* if fewer than 500 units
  sold in the year (prorated for the current year), otherwise *Slow Moving*.
- **Procurement Summary** = the 5 most recent purchase orders.

The 2025 sample data (543 sales transactions) reproduces the figures in the paper exactly:
total ₱2,389,970, average ₱199,164, highest December ₱289,430, lowest February ₱128,420.
The figures are simulated estimates.

## Files

```
index.html               Web interface (single page)
assets/css/style.css     Styles
assets/js/app.js         Pages, forms and tables
assets/js/charts.js      Bar and donut charts (SVG, works offline)
assets/js/backend.js     In-browser "API": validation, business rules, localStorage database
assets/js/seed.js        Sample data (converted from the MySQL database)
php-version/             The original PHP + MySQL backend (for reference; not used by the site)
```
