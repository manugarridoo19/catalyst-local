// Seed list de tickers populares US. Cada entrada: símbolo + variantes del
// nombre (con Inc/Corp/Group eliminado, alias coloquiales, etc.).
// El extractor recorre estas alias contra el headline+body para detectar
// menciones que no traen `$TICKER` literal.

export type TickerSeed = {
  symbol: string;
  name: string;
  aliases: string[];
};

export const TICKER_SEEDS: TickerSeed[] = [
  // Mega-cap tech
  { symbol: "AAPL", name: "Apple Inc", aliases: ["Apple", "Apple Inc", "Apple's", "iPhone maker"] },
  { symbol: "MSFT", name: "Microsoft Corporation", aliases: ["Microsoft", "Microsoft Corp", "Microsoft's"] },
  { symbol: "GOOGL", name: "Alphabet Inc", aliases: ["Alphabet", "Google", "Alphabet Inc", "Google's", "YouTube"] },
  { symbol: "GOOG", name: "Alphabet Inc Class C", aliases: ["Alphabet Class C"] },
  { symbol: "AMZN", name: "Amazon.com Inc", aliases: ["Amazon", "Amazon.com", "Amazon's", "AWS"] },
  { symbol: "META", name: "Meta Platforms Inc", aliases: ["Meta", "Meta Platforms", "Facebook", "Instagram", "Meta's"] },
  { symbol: "NVDA", name: "NVIDIA Corporation", aliases: ["Nvidia", "NVIDIA", "Nvidia's"] },
  { symbol: "TSLA", name: "Tesla Inc", aliases: ["Tesla", "Tesla Inc", "Tesla's", "Elon Musk"] },
  { symbol: "AVGO", name: "Broadcom Inc", aliases: ["Broadcom"] },
  { symbol: "ORCL", name: "Oracle Corporation", aliases: ["Oracle"] },
  { symbol: "ADBE", name: "Adobe Inc", aliases: ["Adobe"] },
  { symbol: "CRM", name: "Salesforce Inc", aliases: ["Salesforce"] },
  { symbol: "CSCO", name: "Cisco Systems Inc", aliases: ["Cisco", "Cisco Systems"] },
  { symbol: "INTC", name: "Intel Corporation", aliases: ["Intel"] },
  { symbol: "AMD", name: "Advanced Micro Devices", aliases: ["AMD", "Advanced Micro Devices"] },
  { symbol: "QCOM", name: "Qualcomm Inc", aliases: ["Qualcomm"] },
  { symbol: "IBM", name: "International Business Machines", aliases: ["IBM"] },
  { symbol: "NFLX", name: "Netflix Inc", aliases: ["Netflix"] },
  { symbol: "DIS", name: "Walt Disney Company", aliases: ["Disney", "Walt Disney"] },
  { symbol: "PYPL", name: "PayPal Holdings Inc", aliases: ["PayPal"] },
  { symbol: "UBER", name: "Uber Technologies Inc", aliases: ["Uber"] },
  { symbol: "SHOP", name: "Shopify Inc", aliases: ["Shopify"] },
  { symbol: "SQ", name: "Block Inc", aliases: ["Block Inc", "Square Inc"] },
  { symbol: "PLTR", name: "Palantir Technologies Inc", aliases: ["Palantir"] },
  { symbol: "SNOW", name: "Snowflake Inc", aliases: ["Snowflake"] },
  { symbol: "SOFI", name: "SoFi Technologies Inc", aliases: ["SoFi"] },
  { symbol: "ZS", name: "Zscaler Inc", aliases: ["Zscaler"] },
  { symbol: "DDOG", name: "Datadog Inc", aliases: ["Datadog"] },
  { symbol: "NET", name: "Cloudflare Inc", aliases: ["Cloudflare"] },
  { symbol: "PINS", name: "Pinterest Inc", aliases: ["Pinterest"] },
  { symbol: "SNAP", name: "Snap Inc", aliases: ["Snap Inc", "Snapchat"] },
  { symbol: "RBLX", name: "Roblox Corporation", aliases: ["Roblox"] },
  { symbol: "U", name: "Unity Software Inc", aliases: ["Unity Software"] },
  { symbol: "COIN", name: "Coinbase Global Inc", aliases: ["Coinbase"] },
  { symbol: "HOOD", name: "Robinhood Markets Inc", aliases: ["Robinhood"] },
  { symbol: "SPOT", name: "Spotify Technology", aliases: ["Spotify"] },
  { symbol: "ABNB", name: "Airbnb Inc", aliases: ["Airbnb"] },
  { symbol: "LYFT", name: "Lyft Inc", aliases: ["Lyft"] },
  { symbol: "DASH", name: "DoorDash Inc", aliases: ["DoorDash"] },
  { symbol: "ROKU", name: "Roku Inc", aliases: ["Roku"] },

  // Financials
  { symbol: "JPM", name: "JPMorgan Chase & Co", aliases: ["JPMorgan", "JPMorgan Chase", "JP Morgan"] },
  { symbol: "BAC", name: "Bank of America Corp", aliases: ["Bank of America"] },
  { symbol: "WFC", name: "Wells Fargo & Company", aliases: ["Wells Fargo"] },
  { symbol: "C", name: "Citigroup Inc", aliases: ["Citigroup", "Citi"] },
  { symbol: "GS", name: "Goldman Sachs Group", aliases: ["Goldman Sachs", "Goldman"] },
  { symbol: "MS", name: "Morgan Stanley", aliases: ["Morgan Stanley"] },
  { symbol: "BLK", name: "BlackRock Inc", aliases: ["BlackRock"] },
  { symbol: "SCHW", name: "Charles Schwab Corp", aliases: ["Charles Schwab", "Schwab"] },
  { symbol: "AXP", name: "American Express Company", aliases: ["American Express", "AmEx"] },
  { symbol: "V", name: "Visa Inc", aliases: ["Visa Inc"] },
  { symbol: "MA", name: "Mastercard Inc", aliases: ["Mastercard"] },
  { symbol: "BRK.B", name: "Berkshire Hathaway", aliases: ["Berkshire Hathaway", "Berkshire", "Buffett"] },

  // Healthcare / pharma
  { symbol: "JNJ", name: "Johnson & Johnson", aliases: ["Johnson & Johnson", "J&J"] },
  { symbol: "UNH", name: "UnitedHealth Group", aliases: ["UnitedHealth"] },
  { symbol: "PFE", name: "Pfizer Inc", aliases: ["Pfizer"] },
  { symbol: "MRK", name: "Merck & Co", aliases: ["Merck"] },
  { symbol: "LLY", name: "Eli Lilly and Company", aliases: ["Eli Lilly", "Lilly"] },
  { symbol: "ABBV", name: "AbbVie Inc", aliases: ["AbbVie"] },
  { symbol: "BMY", name: "Bristol-Myers Squibb", aliases: ["Bristol-Myers Squibb", "Bristol Myers"] },
  { symbol: "AMGN", name: "Amgen Inc", aliases: ["Amgen"] },
  { symbol: "GILD", name: "Gilead Sciences Inc", aliases: ["Gilead"] },
  { symbol: "MRNA", name: "Moderna Inc", aliases: ["Moderna"] },
  { symbol: "BNTX", name: "BioNTech SE", aliases: ["BioNTech"] },
  { symbol: "NVO", name: "Novo Nordisk", aliases: ["Novo Nordisk"] },

  // Energy
  { symbol: "XOM", name: "Exxon Mobil Corporation", aliases: ["Exxon", "ExxonMobil", "Exxon Mobil"] },
  { symbol: "CVX", name: "Chevron Corporation", aliases: ["Chevron"] },
  { symbol: "COP", name: "ConocoPhillips", aliases: ["ConocoPhillips"] },
  { symbol: "SLB", name: "Schlumberger Limited", aliases: ["Schlumberger"] },
  { symbol: "OXY", name: "Occidental Petroleum", aliases: ["Occidental Petroleum", "Occidental"] },

  // Consumer
  { symbol: "WMT", name: "Walmart Inc", aliases: ["Walmart"] },
  { symbol: "COST", name: "Costco Wholesale", aliases: ["Costco"] },
  { symbol: "HD", name: "Home Depot Inc", aliases: ["Home Depot"] },
  { symbol: "LOW", name: "Lowe's Companies", aliases: ["Lowe's"] },
  { symbol: "TGT", name: "Target Corporation", aliases: ["Target Corp", "Target Corporation"] },
  { symbol: "NKE", name: "Nike Inc", aliases: ["Nike"] },
  { symbol: "MCD", name: "McDonald's Corporation", aliases: ["McDonald's", "McDonalds"] },
  { symbol: "SBUX", name: "Starbucks Corporation", aliases: ["Starbucks"] },
  { symbol: "KO", name: "Coca-Cola Company", aliases: ["Coca-Cola", "Coke"] },
  { symbol: "PEP", name: "PepsiCo Inc", aliases: ["PepsiCo", "Pepsi"] },
  { symbol: "PG", name: "Procter & Gamble", aliases: ["Procter & Gamble", "P&G"] },
  { symbol: "UL", name: "Unilever PLC", aliases: ["Unilever"] },

  // Industrial / aerospace
  { symbol: "BA", name: "Boeing Company", aliases: ["Boeing"] },
  { symbol: "LMT", name: "Lockheed Martin", aliases: ["Lockheed Martin"] },
  { symbol: "RTX", name: "RTX Corporation", aliases: ["Raytheon"] },
  { symbol: "NOC", name: "Northrop Grumman", aliases: ["Northrop Grumman"] },
  { symbol: "GE", name: "General Electric", aliases: ["General Electric"] },
  { symbol: "CAT", name: "Caterpillar Inc", aliases: ["Caterpillar"] },
  { symbol: "DE", name: "Deere & Company", aliases: ["Deere", "John Deere"] },
  { symbol: "F", name: "Ford Motor Company", aliases: ["Ford Motor", "Ford Motor Company"] },
  { symbol: "GM", name: "General Motors", aliases: ["General Motors"] },
  { symbol: "RIVN", name: "Rivian Automotive", aliases: ["Rivian"] },
  { symbol: "LCID", name: "Lucid Group", aliases: ["Lucid Motors", "Lucid Group"] },
  { symbol: "NIO", name: "NIO Inc", aliases: ["NIO Inc"] },
  { symbol: "BYDDY", name: "BYD Company", aliases: ["BYD"] },
  { symbol: "FDX", name: "FedEx Corporation", aliases: ["FedEx"] },
  { symbol: "UPS", name: "United Parcel Service", aliases: ["UPS Inc", "United Parcel Service"] },

  // Telecom / media
  { symbol: "T", name: "AT&T Inc", aliases: ["AT&T"] },
  { symbol: "VZ", name: "Verizon Communications", aliases: ["Verizon"] },
  { symbol: "TMUS", name: "T-Mobile US", aliases: ["T-Mobile"] },
  { symbol: "CMCSA", name: "Comcast Corporation", aliases: ["Comcast"] },
  { symbol: "WBD", name: "Warner Bros. Discovery", aliases: ["Warner Bros", "Warner Bros. Discovery"] },
  { symbol: "PARA", name: "Paramount Global", aliases: ["Paramount Global"] },

  // Real estate / REITs (selectivos)
  { symbol: "AMT", name: "American Tower Corp", aliases: ["American Tower"] },
  { symbol: "PLD", name: "Prologis Inc", aliases: ["Prologis"] },

  // Crypto-adjacent
  { symbol: "MSTR", name: "Strategy Inc", aliases: ["Strategy Inc", "MicroStrategy"] },
  { symbol: "MARA", name: "Marathon Digital", aliases: ["Marathon Digital"] },
  { symbol: "RIOT", name: "Riot Platforms", aliases: ["Riot Platforms", "Riot Blockchain"] },

  // Chinese ADRs
  { symbol: "BABA", name: "Alibaba Group", aliases: ["Alibaba"] },
  { symbol: "JD", name: "JD.com Inc", aliases: ["JD.com"] },
  { symbol: "PDD", name: "PDD Holdings", aliases: ["PDD Holdings", "Pinduoduo"] },
  { symbol: "BIDU", name: "Baidu Inc", aliases: ["Baidu"] },
  { symbol: "TCEHY", name: "Tencent Holdings", aliases: ["Tencent"] },

  // Semis (additional)
  { symbol: "TSM", name: "Taiwan Semiconductor Manufacturing", aliases: ["TSMC", "Taiwan Semiconductor"] },
  { symbol: "ASML", name: "ASML Holding", aliases: ["ASML"] },
  { symbol: "MU", name: "Micron Technology", aliases: ["Micron"] },
  { symbol: "AMAT", name: "Applied Materials", aliases: ["Applied Materials"] },
  { symbol: "LRCX", name: "Lam Research", aliases: ["Lam Research"] },
  { symbol: "ARM", name: "Arm Holdings", aliases: ["Arm Holdings"] },

  // Other notable
  { symbol: "BX", name: "Blackstone Inc", aliases: ["Blackstone"] },
  { symbol: "KKR", name: "KKR & Co", aliases: ["KKR"] },
  { symbol: "ARES", name: "Ares Management", aliases: ["Ares Management"] },
  { symbol: "DAL", name: "Delta Air Lines", aliases: ["Delta Air Lines", "Delta Airlines"] },
  { symbol: "UAL", name: "United Airlines", aliases: ["United Airlines"] },
  { symbol: "AAL", name: "American Airlines", aliases: ["American Airlines"] },
  { symbol: "BKNG", name: "Booking Holdings", aliases: ["Booking Holdings", "Booking.com"] },
  { symbol: "MAR", name: "Marriott International", aliases: ["Marriott"] },

  // ETFs (commonly mentioned in macro coverage)
  { symbol: "SPY", name: "SPDR S&P 500 ETF", aliases: ["SPDR S&P 500"] },
  { symbol: "QQQ", name: "Invesco QQQ", aliases: ["Invesco QQQ"] },
  { symbol: "IWM", name: "iShares Russell 2000", aliases: ["Russell 2000 ETF"] },
];
