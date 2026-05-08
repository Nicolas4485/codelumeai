# Add your Anthropic API key

CodeLumeAI sends your source code to Anthropic's API to generate plain-English translations. You'll need your own API key.

## How to get a key

1. Go to [console.anthropic.com](https://console.anthropic.com/)
2. Sign in or create an account
3. Navigate to **API Keys** → **Create Key**
4. Copy the key (it starts with `sk-`)

## Where the key is stored

Your key is stored in **VS Code's SecretStorage** — encrypted by the OS, never written to `settings.json`, never committed to a repo, never logged.

Click the button below to paste your key in.
