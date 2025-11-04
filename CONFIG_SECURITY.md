# Configuration Security

## Important Security Notes

### Database Credentials

The `config.json` file contains database credentials. For production use:

1. **Do NOT commit real credentials to version control**
2. Use environment variables instead:
   - `DB_HOST`
   - `DB_PORT`
   - `DB_USER`
   - `DB_PASSWORD`
   - `DB_NAME`

3. Add `config.json` to `.gitignore` if it contains real credentials
4. Use `config.example.json` as a template with placeholder values

### JWT Secret

The JWT secret should be set via the `JWT_SECRET` environment variable:

```bash
# Generate a secure random secret:
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"

# Set it in your environment:
export JWT_SECRET=your-generated-secret-here
```

Never commit the actual JWT secret to version control!

### Admin Credentials

Set the admin username and password via environment variables:

```bash
export ADMIN_USERNAME=your-admin-username
export ADMIN_PASSWORD=your-secure-password
```

If not set, a random password will be generated and displayed on first startup.

## Using .env File

Create a `.env` file (based on `.env.example`) with your credentials:

```bash
cp .env.example .env
# Edit .env with your actual credentials
```

The `.env` file should be in `.gitignore` to prevent accidental commits.
