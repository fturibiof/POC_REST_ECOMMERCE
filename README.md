# POC — REST E-Commerce Microservices

A proof-of-concept e-commerce system where five Node.js services communicate
synchronously via REST. Designed to make it easy to measure **latency** and
**throughput** of the full purchase pipeline.

---

## Architecture

```
Client
  │
  │  POST /orders
  ▼
┌─────────────────┐        POST /payments
│  Order Service  │ ──────────────────────────► Payment Service   (port 3001)
│   (port 3000)   │        POST /inventory/reserve
│                 │ ──────────────────────────► Inventory Service (port 3002)
│                 │        POST /shipments
│                 │ ──────────────────────────► Shipping Service  (port 3003)
│                 │        POST /notifications
│                 │ ──────────────────────────► Notification Service (port 3004)
└─────────────────┘
  │
  │  201 — full order summary
  ▼
Client
```

All calls are **synchronous** — the Order Service awaits each downstream
response before proceeding to the next step.

---

## Services & Ports

| Service       | Port | Responsibility                                      |
|---------------|------|-----------------------------------------------------|
| Order         | 3000 | Client entry point, orchestrates the full flow      |
| Payment       | 3001 | Simulates card authorisation                        |
| Inventory     | 3002 | Checks stock and reserves items                     |
| Shipping      | 3003 | Creates a shipment and returns a tracking number    |
| Notification  | 3004 | Simulates sending a confirmation email/SMS          |

---

## Quick Start

```bash
npm install        # once
npm start          # starts all 5 services concurrently
```

---

## Making a Purchase

```bash
curl -s -X POST http://localhost:3000/orders \
  -H "Content-Type: application/json" \
  -d '{
    "customerId": "CUST-42",
    "items": [
      { "itemId": "ITEM-001", "quantity": 1 },
      { "itemId": "ITEM-002", "quantity": 2 }
    ],
    "paymentInformation": {
      "cardNumber": "4111111111111111",
      "cardHolder": "Jane Doe",
      "expiryDate": "12/28",
      "cvv": "123"
    },
    "shippingAddress": {
      "street": "123 Main St",
      "city": "Springfield",
      "state": "IL",
      "zipCode": "62701",
      "country": "US"
    }
  }' | json_pp
```

### Simulate a payment failure

Use a card number ending in `0000`:

```bash
"cardNumber": "4111111100000000"
```

### Simulate an out-of-stock error

Request more units than are in stock (e.g. `ITEM-004` has only 5 units):

```bash
{ "itemId": "ITEM-004", "quantity": 99 }
```

---

## In-Memory Inventory

| itemId   | Name        | Starting Qty |
|----------|-------------|--------------|
| ITEM-001 | Laptop      | 10           |
| ITEM-002 | Mouse       | 50           |
| ITEM-003 | Keyboard    | 30           |
| ITEM-004 | Monitor     | 5            |
| ITEM-005 | Headphones  | 20           |

Stock **resets** every time you restart the services.

---

## Debug / Inspection Endpoints

| GET                           | Returns                            |
|-------------------------------|------------------------------------|
| `localhost:3000/orders`       | All orders received                |
| `localhost:3001/payments`     | All payment transactions           |
| `localhost:3002/inventory/stock` | Current stock levels            |
| `localhost:3002/inventory/reservations` | All reservations          |
| `localhost:3003/shipments`    | All shipments created              |
| `localhost:3004/notifications`| All notifications sent             |

---

## Measuring Latency & Throughput

Every successful order response includes a `latencyMs` field — the
end-to-end time from when the Order Service received the request to when
it returned the response.

For load testing you can use tools such as:

```bash
# Example with k6
k6 run load-test.js

# Example with autocannon (Node.js)
npx autocannon -m POST -H "Content-Type: application/json" \
  -b '{"customerId":"CUST-1","items":[{"itemId":"ITEM-002","quantity":1}],...}' \
  -c 10 -d 30 http://localhost:3000/orders
```

---

## Project Structure

```
POC_REST_ECOMMERCE/
├── package.json
├── README.md
└── services/
    ├── order/index.js
    ├── payment/index.js
    ├── inventory/index.js
    ├── shipping/index.js
    └── notification/index.js
```
