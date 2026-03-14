# Existing Users Table in Supabase

The application uses the existing `users` table in Supabase with the following structure:

```sql
create table public.users (
  id uuid not null default extensions.uuid_generate_v4 (),
  username text null,
  password text null,
  role text null,
  btc double precision null default 0,
  eth double precision null default 0,
  usdt double precision null default 0,
  constraint users_pkey primary key (id),
  constraint users_username_key unique (username)
) TABLESPACE pg_default;
```

### Explanation:
- `id`: UUID primary key (auto-generated)
- `username`: Unique username for login
- `password`: AES encrypted password in format `$crypt::<encrypted_data>`
- `role`: User role ('client' or 'merchant')
- `btc`, `eth`, `usdt`: Balance columns for each cryptocurrency, defaulting to 0

### Initial Data Insertion:
If migrating from `users.json`, insert the data like this (note: passwords will be AES encrypted during signup):

```sql
INSERT INTO users (username, password, role, btc, eth, usdt) VALUES
('athul', '$crypt::U2FsdGVkX1+...', 'client', 0.0523, 1.1731, 5000.00),
('merchant1', '$crypt::U2FsdGVkX1+...', 'merchant', 0.0, 0.0, 0.0),
('merchant2', '$crypt::U2FsdGVkX1+...', 'merchant', 0.0, 0.0, 0.0),
('anjana', '$crypt::U2FsdGVkX1+...', 'client', 0.0, 0.0, 0.0),
('grizi', '$crypt::U2FsdGVkX1+...', 'client', 0.0, 0.0, 0.0);
```

**Important**: Use the `/signup` endpoint to create users - it will automatically encrypt passwords. The encrypted format is `$crypt::<encrypted_data>`.