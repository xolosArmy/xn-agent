# Eliza

## Edit the character files

Open `src/character.ts` to modify the default character. Uncomment and edit.

### Custom characters

To load custom characters instead:
- Use `pnpm start --characters="path/to/your/character.json"`
- Multiple character files can be loaded simultaneously

### Add clients
```
# in character.ts
clients: [Clients.TWITTER, Clients.DISCORD],

# in character.json
clients: ["twitter", "discord"]
```

## Duplicate the .env.example template

```bash
cp .env.example .env
```

\* Fill out the .env file with your own values.

### Add login credentials and keys to .env
```
DISCORD_APPLICATION_ID="discord-application-id"
DISCORD_API_TOKEN="discord-api-token"
...
OPENROUTER_API_KEY="sk-xx-xx-xxx"
...
TWITTER_USERNAME="username"
TWITTER_PASSWORD="password"
TWITTER_EMAIL="your@email.com"
```

## Install dependencies and start your agent

```bash
pnpm i && pnpm start
```
Note: this requires node to be at least version 22 when you install packages and run the agent.

## Trivia Rewards (XoloGuardian)

### Env vars
```
CHRONIK_URL=https://chronik.example
RMZ_TOKEN_ID=...
RMZSTATE_TOKEN_ID=...
REWARD_WALLET_MNEMONIC=... # or REWARD_WALLET_WIF
REWARD_DRY_RUN=false
TRIVIA_ADMIN_TOKEN=... # Bearer token for admin endpoints
TRIVIA_SALT=... # server secret
DAILY_CAP_RMZ=50
CLAIM_RATE_LIMIT_PER_MINUTE=10
MAX_WIN_PER_USER_PER_DAY=1
MAX_RMZ_PER_USER_PER_DAY=3
```

### Create a trivia
```
curl -X POST http://localhost:3000/api/trivia/create \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TRIVIA_ADMIN_TOKEN>" \
  -d '{
    "triviaId": "trivia-001",
    "tweetId": "1850000000000000000",
    "correctAnswers": ["respuesta correcta", "otra respuesta"]
  }'
```

### Close a trivia (collect replies + deterministic draw)
```
curl -X POST http://localhost:3000/api/trivia/close \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <TRIVIA_ADMIN_TOKEN>" \
  -d '{"triviaId":"trivia-001"}'
```

### Claim reward (token-gated by RMZState NFT)
```
curl -X POST http://localhost:3000/api/claim \
  -H "Content-Type: application/json" \
  -d '{"claimCode":"<code>","address":"ecash:..."}'
```
Note: `address` is the RMZState NFT owner address and also the payout address.

Notes:
- `TRIVIA_SALT` is required for deterministic winner selection.
- Reply collection uses Twitter search via the existing client; ensure the account can access search.
- RMZ payout requires implementation in `src/triviaRewards/rmzSend.ts`.

## Run with Docker

### Build and run Docker Compose (For x86_64 architecture)

#### Edit the docker-compose.yaml file with your environment variables

```yaml
services:
    eliza:
        environment:
            - OPENROUTER_API_KEY=blahdeeblahblahblah
```

#### Run the image

```bash
docker compose up
```

### Build the image with Mac M-Series or aarch64

Make sure docker is running.

```bash
# The --load flag ensures the built image is available locally
docker buildx build --platform linux/amd64 -t eliza-starter:v1 --load .
```

#### Edit the docker-compose-image.yaml file with your environment variables

```yaml
services:
    eliza:
        environment:
            - OPENROUTER_API_KEY=blahdeeblahblahblah
```

#### Run the image

```bash
docker compose -f docker-compose-image.yaml up
```

# Deploy with Railway

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/template/aW47_j)
