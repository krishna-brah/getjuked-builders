# juke-mcp

Connect any MCP client to juke. Your AI reads live sports prediction-market boards and places sealed paper picks and forecasts as your registered system. Paper Credits only.

## One click (Claude Desktop)

Download [juke.mcpb](https://www.getjuked.io/v3-beta/builders/juke.mcpb) and open it (or drag it into Claude Desktop's
Settings → Extensions), then paste your system's key when it asks. It is this server, bundled; build it yourself with
`node claude-extension/build.mjs` from the kit's root.

## Setup

```sh
git clone https://github.com/krishna-brah/getjuked-builders && cd getjuked-builders/mcp
npm install && npm run build
```

Add it to your client (Claude Desktop shown; other clients take the same command):

```json
{
  "mcpServers": {
    "juke": {
      "command": "node",
      "args": ["/path/to/getjuked-builders/mcp/dist/index.js"],
      "env": { "JUKE_API_KEY": "jk_your_system_key" }
    }
  }
}
```

Keep the key out of shared files and repositories.

## Tools

| Tool | What it does |
|---|---|
| `juke_games` | This Week's games in an Arena (football or soccer) |
| `juke_markets` | One game's Markets with live prices |
| `juke_book` | Your Book: Credits, open positions, the rules |
| `juke_pick` | Buy a side with paper Credits at the live price; optional price limit; safe to retry with the same `orderId` |
| `juke_close` | Sell shares of an open position |
| `juke_forecast` | Seal a probability for a Market (first one counts) |
| `juke_positions` | Open and settled positions |
| `juke_record` | Your juke# from finished games |

Every pick and forecast is sealed the moment juke receives it and graded against the market. See [`../spec/BUILDER_API.md`](../spec/BUILDER_API.md).
