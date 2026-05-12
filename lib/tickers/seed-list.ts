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
  // Block Inc renombró ticker SQ → XYZ en Aug 2025. SQ se mantiene por
  // datos históricos pero las menciones actuales deben atribuirse a XYZ.
  { symbol: "XYZ", name: "Block Inc", aliases: ["Block Inc"] },
  { symbol: "SQ", name: "Block Inc (legacy)", aliases: ["Square Inc"] },
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

  // 2026-05-12 Task B — Mid-cap S&P/Russell adds.
  // Curados específicamente porque (a) aparecen en news feeds y (b) tienen
  // aliases distintivos (3+ chars, no genéricos). Los originalmente
  // nombrados en checkpoint (RDNT, CPT, EVH, ESS, HMC, LUMN, GPK, PRMW)
  // más VIST para cubrir el unattributed "Vista Oil" tras G.
  { symbol: "RDNT", name: "RadNet Inc", aliases: ["RadNet"] },
  { symbol: "CPT", name: "Camden Property Trust", aliases: ["Camden Property Trust"] },
  { symbol: "EVH", name: "Evolent Health", aliases: ["Evolent Health"] },
  { symbol: "ESS", name: "Essex Property Trust", aliases: ["Essex Property Trust"] },
  { symbol: "HMC", name: "Honda Motor Co", aliases: ["Honda Motor", "Honda Motor Co"] },
  { symbol: "LUMN", name: "Lumen Technologies", aliases: ["Lumen Technologies", "CenturyLink"] },
  { symbol: "GPK", name: "Graphic Packaging Holding", aliases: ["Graphic Packaging"] },
  { symbol: "PRMW", name: "Primo Brands Corporation", aliases: ["Primo Water", "Primo Brands"] },
  { symbol: "VIST", name: "Vista Energy", aliases: ["Vista Energy", "Vista Oil & Gas", "Vista Oil"] },

  // Healthcare / pharma mid-caps con strong news flow
  { symbol: "MOH", name: "Molina Healthcare Inc", aliases: ["Molina Healthcare"] },
  { symbol: "CNC", name: "Centene Corporation", aliases: ["Centene"] },
  { symbol: "HUM", name: "Humana Inc", aliases: ["Humana"] },
  { symbol: "ELV", name: "Elevance Health", aliases: ["Elevance Health"] },
  { symbol: "CVS", name: "CVS Health Corporation", aliases: ["CVS Health"] },
  { symbol: "WBA", name: "Walgreens Boots Alliance", aliases: ["Walgreens Boots Alliance", "Walgreens"] },
  { symbol: "BIIB", name: "Biogen Inc", aliases: ["Biogen"] },
  { symbol: "REGN", name: "Regeneron Pharmaceuticals", aliases: ["Regeneron"] },
  { symbol: "VRTX", name: "Vertex Pharmaceuticals", aliases: ["Vertex Pharmaceuticals"] },
  { symbol: "ISRG", name: "Intuitive Surgical", aliases: ["Intuitive Surgical"] },
  { symbol: "DXCM", name: "DexCom Inc", aliases: ["DexCom"] },
  { symbol: "ZBH", name: "Zimmer Biomet Holdings", aliases: ["Zimmer Biomet"] },
  { symbol: "ALGN", name: "Align Technology", aliases: ["Align Technology"] },
  { symbol: "IDXX", name: "IDEXX Laboratories", aliases: ["IDEXX Laboratories"] },

  // Energy mid-caps
  { symbol: "EOG", name: "EOG Resources Inc", aliases: ["EOG Resources"] },
  { symbol: "PSX", name: "Phillips 66", aliases: ["Phillips 66"] },
  { symbol: "VLO", name: "Valero Energy Corporation", aliases: ["Valero Energy"] },
  { symbol: "MPC", name: "Marathon Petroleum", aliases: ["Marathon Petroleum"] },
  { symbol: "HES", name: "Hess Corporation", aliases: ["Hess Corp", "Hess Corporation"] },
  { symbol: "DVN", name: "Devon Energy Corporation", aliases: ["Devon Energy"] },
  { symbol: "FANG", name: "Diamondback Energy", aliases: ["Diamondback Energy"] },
  { symbol: "EQT", name: "EQT Corporation", aliases: ["EQT Corporation"] },
  { symbol: "CTRA", name: "Coterra Energy", aliases: ["Coterra Energy"] },

  // Financials mid-caps
  { symbol: "USB", name: "U.S. Bancorp", aliases: ["U.S. Bancorp"] },
  { symbol: "PNC", name: "PNC Financial Services", aliases: ["PNC Financial"] },
  { symbol: "TFC", name: "Truist Financial Corporation", aliases: ["Truist Financial"] },
  { symbol: "COF", name: "Capital One Financial", aliases: ["Capital One Financial"] },
  { symbol: "DFS", name: "Discover Financial", aliases: ["Discover Financial"] },
  { symbol: "CME", name: "CME Group", aliases: ["CME Group"] },
  { symbol: "ICE", name: "Intercontinental Exchange", aliases: ["Intercontinental Exchange"] },
  { symbol: "MCO", name: "Moody's Corporation", aliases: ["Moody's Corporation"] },
  { symbol: "SPGI", name: "S&P Global Inc", aliases: ["S&P Global"] },
  { symbol: "MMC", name: "Marsh & McLennan", aliases: ["Marsh & McLennan"] },
  { symbol: "AON", name: "Aon plc", aliases: ["Aon plc"] },

  // Industrial / aerospace mid-caps
  { symbol: "HON", name: "Honeywell International", aliases: ["Honeywell"] },
  { symbol: "EMR", name: "Emerson Electric", aliases: ["Emerson Electric"] },
  { symbol: "ETN", name: "Eaton Corporation", aliases: ["Eaton Corporation"] },
  { symbol: "PH", name: "Parker Hannifin", aliases: ["Parker Hannifin"] },
  { symbol: "ITW", name: "Illinois Tool Works", aliases: ["Illinois Tool Works"] },
  { symbol: "GD", name: "General Dynamics", aliases: ["General Dynamics"] },
  { symbol: "TDG", name: "TransDigm Group", aliases: ["TransDigm"] },
  { symbol: "PWR", name: "Quanta Services", aliases: ["Quanta Services"] },
  { symbol: "POWL", name: "Powell Industries", aliases: ["Powell Industries"] },

  // Consumer mid-caps
  { symbol: "CMG", name: "Chipotle Mexican Grill", aliases: ["Chipotle Mexican Grill", "Chipotle"] },
  { symbol: "YUM", name: "Yum! Brands", aliases: ["Yum! Brands", "Yum Brands"] },
  { symbol: "DPZ", name: "Domino's Pizza", aliases: ["Domino's Pizza"] },
  { symbol: "DRI", name: "Darden Restaurants", aliases: ["Darden Restaurants"] },
  { symbol: "PZZA", name: "Papa John's International", aliases: ["Papa John's", "Papa Johns"] },
  { symbol: "SHAK", name: "Shake Shack", aliases: ["Shake Shack"] },
  { symbol: "ULTA", name: "Ulta Beauty", aliases: ["Ulta Beauty"] },
  { symbol: "EL", name: "Estee Lauder Companies", aliases: ["Estee Lauder", "Estée Lauder"] },
  { symbol: "TJX", name: "TJX Companies", aliases: ["TJX Companies"] },
  { symbol: "ROST", name: "Ross Stores", aliases: ["Ross Stores"] },
  { symbol: "BURL", name: "Burlington Stores", aliases: ["Burlington Stores"] },
  { symbol: "BIRK", name: "Birkenstock Holding", aliases: ["Birkenstock"] },
  { symbol: "DECK", name: "Deckers Outdoor", aliases: ["Deckers Outdoor"] },
  { symbol: "LULU", name: "Lululemon Athletica", aliases: ["Lululemon"] },
  { symbol: "PVH", name: "PVH Corp", aliases: ["PVH Corp"] },
  { symbol: "RL", name: "Ralph Lauren Corporation", aliases: ["Ralph Lauren"] },
  { symbol: "TPR", name: "Tapestry Inc", aliases: ["Tapestry Inc"] },
  { symbol: "CPRI", name: "Capri Holdings", aliases: ["Capri Holdings"] },

  // Tech / software mid-caps
  { symbol: "WDAY", name: "Workday Inc", aliases: ["Workday Inc"] },
  { symbol: "ADSK", name: "Autodesk Inc", aliases: ["Autodesk"] },
  { symbol: "INTU", name: "Intuit Inc", aliases: ["Intuit"] },
  { symbol: "MDB", name: "MongoDB Inc", aliases: ["MongoDB"] },
  { symbol: "TEAM", name: "Atlassian Corporation", aliases: ["Atlassian"] },
  { symbol: "PANW", name: "Palo Alto Networks", aliases: ["Palo Alto Networks"] },
  { symbol: "CRWD", name: "CrowdStrike Holdings", aliases: ["CrowdStrike"] },
  { symbol: "FTNT", name: "Fortinet Inc", aliases: ["Fortinet"] },
  { symbol: "OKTA", name: "Okta Inc", aliases: ["Okta Inc"] },
  { symbol: "DOCU", name: "DocuSign Inc", aliases: ["DocuSign"] },
  { symbol: "ZM", name: "Zoom Communications", aliases: ["Zoom Communications", "Zoom Video"] },
  { symbol: "CHTR", name: "Charter Communications", aliases: ["Charter Communications"] },
  { symbol: "EA", name: "Electronic Arts", aliases: ["Electronic Arts"] },
  { symbol: "TTWO", name: "Take-Two Interactive", aliases: ["Take-Two Interactive"] },
  { symbol: "GTM", name: "ZoomInfo Technologies", aliases: ["ZoomInfo"] },
  { symbol: "PEGA", name: "Pegasystems Inc", aliases: ["Pegasystems"] },

  // REIT/RE mid-caps
  { symbol: "EQIX", name: "Equinix Inc", aliases: ["Equinix"] },
  { symbol: "DLR", name: "Digital Realty Trust", aliases: ["Digital Realty"] },
  { symbol: "WELL", name: "Welltower Inc", aliases: ["Welltower"] },
  { symbol: "PSA", name: "Public Storage", aliases: ["Public Storage"] },
  { symbol: "O", name: "Realty Income Corporation", aliases: ["Realty Income"] },
  { symbol: "AVB", name: "AvalonBay Communities", aliases: ["AvalonBay Communities"] },
  { symbol: "EQR", name: "Equity Residential", aliases: ["Equity Residential"] },
  { symbol: "INVH", name: "Invitation Homes", aliases: ["Invitation Homes"] },
  { symbol: "VTR", name: "Ventas Inc", aliases: ["Ventas Inc"] },
  { symbol: "LTC", name: "LTC Properties", aliases: ["LTC Properties"] },

  // Other notable
  { symbol: "SRE", name: "Sempra Energy", aliases: ["Sempra Energy"] },
  { symbol: "DUK", name: "Duke Energy Corporation", aliases: ["Duke Energy"] },
  { symbol: "SO", name: "Southern Company", aliases: ["Southern Company"] },
  { symbol: "NEE", name: "NextEra Energy", aliases: ["NextEra Energy"] },
  { symbol: "MCK", name: "McKesson Corporation", aliases: ["McKesson"] },
  { symbol: "STX", name: "Seagate Technology", aliases: ["Seagate Technology", "Seagate Tech"] },
  { symbol: "WDC", name: "Western Digital", aliases: ["Western Digital"] },
  { symbol: "SONY", name: "Sony Group Corporation", aliases: ["Sony Group", "Sony Corporation"] },
  { symbol: "DOCS", name: "Doximity Inc", aliases: ["Doximity"] },
  { symbol: "MNST", name: "Monster Beverage", aliases: ["Monster Beverage"] },
  { symbol: "MBI", name: "MBIA Inc", aliases: ["MBIA Inc"] },
  { symbol: "NBIS", name: "Nebius Group", aliases: ["Nebius Group", "Nebius"] },
  { symbol: "IREN", name: "IREN Limited", aliases: ["IREN Limited"] },
  { symbol: "EOSE", name: "Eos Energy Enterprises", aliases: ["Eos Energy"] },
  { symbol: "GPN", name: "Global Payments Inc", aliases: ["Global Payments"] },
  { symbol: "FTRE", name: "Fortrea Holdings", aliases: ["Fortrea Holdings", "Fortrea"] },
  { symbol: "ARTV", name: "Artiva Biotherapeutics", aliases: ["Artiva Biotherapeutics"] },
  { symbol: "ALLE", name: "Allegion plc", aliases: ["Allegion plc", "Allegion"] },
  { symbol: "STM", name: "STMicroelectronics", aliases: ["STMicroelectronics"] },
];
