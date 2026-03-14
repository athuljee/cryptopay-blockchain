# API Testing with cURL

This document contains cURL commands to test the CryptoPay Blockchain API endpoints.

## Prerequisites

- Server running on `http://localhost:3000` (adjust if different)
- Users exist in the database (signup first if needed)
- **Note**: Passwords are now AES encrypted. Existing users in DB may need re-signup or manual password update.

## 1. Signup (Create New User)

```bash
curl -X POST http://localhost:3000/signup \
  -H "Content-Type: application/json" \
  -d '{
    "username": "testuser",
    "password": "testpass",
    "role": "client"
  }'
```

## 2. Login

```bash
curl -X POST http://localhost:3000/login \
  -H "Content-Type: application/json" \
  -d '{
    "username": "athul",
    "password": "1234"
  }'
```

## 3. Get Token Values

```bash
curl -X GET http://localhost:3000/token-values
```

## 4. Check Balance

```bash
curl -X GET http://localhost:3000/balance/athul
```

## 5. Add Transaction

```bash
curl -X POST http://localhost:3000/transaction \
  -H "Content-Type: application/json" \
  -d '{
    "sender": "athul",
    "receiver": "merchant1",
    "amount": 100,
    "token": "USDT"
  }'
```

## 6. Mine Pending Transactions

```bash
curl -X GET http://localhost:3000/mine
```

## 7. Check Updated Balance After Mining

```bash
curl -X GET http://localhost:3000/balance/athul
curl -X GET http://localhost:3000/balance/merchant1
```

## 8. Get Blockchain Chain

```bash
curl -X GET http://localhost:3000/chain
```

## 9. Payment Notification (for merchants)

```bash
curl -X POST http://localhost:3000/notify-payment \
  -H "Content-Type: application/json" \
  -d '{
    "amount": 100,
    "token": "USDT",
    "from": "athul",
    "to": "merchant1"
  }'
```

## 10. Get Last Payment Notification

```bash
curl -X GET http://localhost:3000/last-payment
```

## 11. Clear Payment Notification

```bash
curl -X POST http://localhost:3000/clear-payment
```

## Complete Test Flow

Here's a sequence to test the full flow:

```bash
# 1. Login as existing user
curl -X POST http://localhost:3000/login -H "Content-Type: application/json" -d '{"username": "athul", "password": "1234"}'

# 2. Check initial balance
curl -X GET http://localhost:3000/balance/athul

# 3. Add a transaction
curl -X POST http://localhost:3000/transaction -H "Content-Type: application/json" -d '{"sender": "athul", "receiver": "merchant1", "amount": 50, "token": "USDT"}'

# 4. Mine the transaction
curl -X GET http://localhost:3000/mine

# 5. Check balances after mining
curl -X GET http://localhost:3000/balance/athul
curl -X GET http://localhost:3000/balance/merchant1

# 6. Notify payment (for merchant terminal)
curl -X POST http://localhost:3000/notify-payment -H "Content-Type: application/json" -d '{"amount": 50, "token": "USDT", "from": "athul", "to": "merchant1"}'

# 7. Get the notification
curl -X GET http://localhost:3000/last-payment

# 8. Clear the notification
curl -X POST http://localhost:3000/clear-payment
```

## Error Testing

### Insufficient Balance

```bash
curl -X POST http://localhost:3000/transaction \
  -H "Content-Type: application/json" \
  -d '{
    "sender": "athul",
    "receiver": "merchant1",
    "amount": 10000,
    "token": "USDT"
  }'
```

### Invalid User

```bash
curl -X POST http://localhost:3000/login \
  -H "Content-Type: application/json" \
  -d '{
    "username": "nonexistent",
    "password": "wrong"
  }'
```

## Notes

- Replace `localhost:3000` with your actual server URL/port
- Ensure the server is running before testing
- Balances are persisted in Supabase, so they maintain state between restarts
- Mining may take a few seconds due to proof-of-work</content>
<parameter name="filePath">c:\Users\amalj\OneDrive\Desktop\project\cryptopay_blockchain\curl.md