import type { RssFeedConfig, WeatherLocation, MarketTicker, CurrencyPair } from './types';

export const RSS_FEEDS: RssFeedConfig[] = [
  // Global / Centrist-Institutional
  { name: 'BBC World', url: 'https://feeds.bbci.co.uk/news/world/rss.xml', category: 'global' },
  { name: 'BBC Business', url: 'https://feeds.bbci.co.uk/news/business/rss.xml', category: 'business' },
  { name: 'BBC Technology', url: 'https://feeds.bbci.co.uk/news/technology/rss.xml', category: 'tech' },
  { name: 'BBC Science', url: 'https://feeds.bbci.co.uk/news/science_and_environment/rss.xml', category: 'science' },
  { name: 'France 24', url: 'https://www.france24.com/en/rss', category: 'global' },
  { name: 'DW', url: 'https://rss.dw.com/rdf/rss-en-all', category: 'global' },
  { name: 'NPR World', url: 'https://feeds.npr.org/1004/rss.xml', category: 'global' },
  { name: 'ABC Australia', url: 'https://www.abc.net.au/news/feed/2942460/rss.xml', category: 'global' },
  { name: 'Globe and Mail', url: 'https://www.theglobeandmail.com/arc/outboundfeeds/rss/category/world/', category: 'global' },

  // Western / Liberal-Leaning
  { name: 'The Guardian World', url: 'https://www.theguardian.com/world/rss', category: 'global' },
  { name: 'The Guardian Science', url: 'https://www.theguardian.com/science/rss', category: 'science' },
  { name: 'NPR News', url: 'https://feeds.npr.org/1002/rss.xml', category: 'global' },
  { name: 'ProPublica', url: 'https://feeds.propublica.org/propublica/main', category: 'global', editorial: true },
  { name: 'Democracy Now', url: 'https://www.democracynow.org/democracynow.rss', category: 'global' },

  // Middle East & Gulf
  { name: 'Al Jazeera', url: 'https://www.aljazeera.com/xml/rss/all.xml', category: 'global' },
  { name: 'Middle East Eye', url: 'https://www.middleeasteye.net/rss', category: 'global' },
  { name: 'Khaleej Times', url: 'https://www.khaleejtimes.com/rss', category: 'global' },
  { name: 'Jerusalem Post', url: 'https://www.jpost.com/rss/rssfeedsfrontpage.aspx', category: 'global' },

  // Iran
  { name: 'Press TV', url: 'https://www.presstv.ir/RSS', category: 'global' },

  // Saudi Arabia — covered by Gulf News above

  // Turkey
  { name: 'Daily Sabah', url: 'https://www.dailysabah.com/rssFeed/Home', category: 'global' },

  // Chinese State / Perspective
  { name: 'Xinhua', url: 'http://www.news.cn/english/rss/worldnews.xml', category: 'global' },
  { name: 'SCMP', url: 'https://www.scmp.com/rss/4/feed', category: 'global' },

  // Russian Perspective
  { name: 'TASS', url: 'https://tass.com/rss/v2.xml', category: 'global' },
  { name: 'Meduza', url: 'https://meduza.io/rss/en/all', category: 'global' },
  { name: 'Moscow Times', url: 'https://www.themoscowtimes.com/rss/news', category: 'global' },

  // Ukraine
  { name: 'Ukrinform', url: 'https://www.ukrinform.net/rss/block-lastnews', category: 'global' },
  { name: 'Ukrainska Pravda', url: 'https://www.pravda.com.ua/eng/rss/', category: 'global' },

  // South Asia
  { name: 'Times of India', url: 'https://timesofindia.indiatimes.com/rssfeedstopstories.cms', category: 'global' },
  { name: 'The Hindu', url: 'https://www.thehindu.com/news/international/feeder/default.rss', category: 'global' },
  { name: 'Dawn (Pakistan)', url: 'https://www.dawn.com/feeds/home', category: 'global' },
  { name: 'NDTV', url: 'https://feeds.feedburner.com/ndtvnews-top-stories', category: 'global' },

  // Southeast Asia
  { name: 'Bangkok Post', url: 'https://www.bangkokpost.com/rss/data/topstories.xml', category: 'global' },
  { name: 'Rappler', url: 'https://www.rappler.com/feed/', category: 'global' },
  { name: 'Channel News Asia', url: 'https://www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml', category: 'global' },
  { name: 'VnExpress Intl', url: 'https://e.vnexpress.net/rss/news.rss', category: 'global' },

  // East Asia
  { name: 'Nikkei Asia', url: 'https://asia.nikkei.com/rss/feed/nar', category: 'business' },
  { name: 'Japan Times', url: 'https://www.japantimes.co.jp/feed/', category: 'global' },
  { name: 'Yonhap News', url: 'https://en.yna.co.kr/RSS/news.xml', category: 'global' },

  // Africa
  { name: 'Daily Maverick', url: 'https://www.dailymaverick.co.za/dmrss/', category: 'global' },
  { name: 'AllAfrica', url: 'https://allafrica.com/tools/headlines/rdf/latest/headlines.rdf', category: 'global' },
  { name: 'Nation Africa', url: 'https://nation.africa/kenya/rss.xml', category: 'global' },
  { name: 'Mail & Guardian', url: 'https://mg.co.za/feed/', category: 'global' },
  { name: 'Mada Masr', url: 'https://www.madamasr.com/en/feed/', category: 'global' },
  { name: 'Premium Times', url: 'https://www.premiumtimesng.com/feed', category: 'global' },
  { name: 'The Punch', url: 'https://punchng.com/feed/', category: 'global' },
  { name: 'African Arguments', url: 'https://africanarguments.org/feed/', category: 'global', editorial: true },
  { name: 'Radio Dabanga', url: 'https://www.dabangasudan.org/en/all-news/feed', category: 'global' },

  // Latin America
  { name: 'MercoPress', url: 'https://en.mercopress.com/rss', category: 'global' },
  { name: 'Tico Times', url: 'https://ticotimes.net/feed', category: 'global' },
  { name: 'Infobae', url: 'https://www.infobae.com/feeds/rss/', category: 'global' },
  { name: 'O Globo', url: 'https://oglobo.globo.com/rss/oglobo.xml', category: 'global' },
  { name: 'CIPER Chile', url: 'https://www.ciperchile.cl/feed/', category: 'global', editorial: true },
  { name: 'El País América', url: 'https://feeds.elpais.com/mrss-s/pages/ep/site/elpais.com/section/america/portada', category: 'global' },

  // Central Asia
  { name: 'The Diplomat', url: 'https://thediplomat.com/feed/', category: 'global' },
  { name: 'CABAR.asia', url: 'https://cabar.asia/en/feed', category: 'global' },
  { name: 'The Astana Times', url: 'https://astanatimes.com/feed/', category: 'global' },

  // Europe / EU
  { name: 'Politico EU', url: 'https://www.politico.eu/feed/', category: 'politics' },
  { name: 'El País', url: 'https://feeds.elpais.com/mrss-s/pages/ep/site/english.elpais.com/portada', category: 'global' },
  { name: 'Euronews', url: 'https://www.euronews.com/rss', category: 'global' },

  // Poland
  { name: 'Gazeta Wyborcza', url: 'https://rss.gazeta.pl/pub/rss/gazetawyborcza_kraj.xml', category: 'poland' },
  { name: 'Rzeczpospolita', url: 'https://www.rp.pl/rss_main', category: 'poland' },
  { name: 'Notes From Poland', url: 'https://notesfrompoland.com/feed/', category: 'poland' },

  // Nepal
  { name: 'Kathmandu Post', url: 'https://kathmandupost.com/rss', category: 'nepal' },
  { name: 'OnlineKhabar', url: 'https://english.onlinekhabar.com/feed', category: 'nepal' },

  // Cyprus
  { name: 'Cyprus Mail', url: 'https://cyprus-mail.com/feed/', category: 'cyprus' },

  // Technology & AI
  { name: 'TechCrunch', url: 'https://techcrunch.com/feed/', category: 'tech' },
  { name: 'The Verge', url: 'https://www.theverge.com/rss/index.xml', category: 'tech' },
  { name: 'Wired', url: 'https://www.wired.com/feed/rss', category: 'tech' },
  { name: 'Rest of World', url: 'https://restofworld.org/feed/latest', category: 'tech' },

  // Science
  { name: 'Science Daily', url: 'https://www.sciencedaily.com/rss/all.xml', category: 'science' },
  { name: 'Nature News', url: 'https://www.nature.com/nature.rss', category: 'science' },

  // Health
  { name: 'STAT News', url: 'https://www.statnews.com/feed/', category: 'health' },
  { name: 'WHO News', url: 'https://www.who.int/rss-feeds/news-english.xml', category: 'health' },

  // Editorial / Investigative / Open-Source (non-paywalled)
  { name: 'Bellingcat', url: 'https://www.bellingcat.com/feed/', category: 'editorial', editorial: true },
  { name: 'The Conversation', url: 'https://theconversation.com/articles.atom', category: 'editorial', editorial: true },
  { name: 'The Intercept', url: 'https://theintercept.com/feed/?rss', category: 'editorial', editorial: true },
  { name: 'Global Voices', url: 'https://globalvoices.org/feed/', category: 'editorial', editorial: true },
  { name: 'Carbon Brief', url: 'https://www.carbonbrief.org/feed', category: 'editorial', editorial: true },
  { name: 'The Markup', url: 'https://themarkup.org/feeds/rss.xml', category: 'editorial', editorial: true },
  { name: 'ICIJ', url: 'https://www.icij.org/feed/', category: 'editorial', editorial: true },
  { name: 'Mongabay', url: 'https://news.mongabay.com/feed/', category: 'editorial', editorial: true },
  { name: 'OCCRP', url: 'https://www.occrp.org/en/feed', category: 'editorial', editorial: true },

  // Sports — Worldwide
  { name: 'BBC Sport', url: 'https://feeds.bbci.co.uk/sport/rss.xml', category: 'sports' },
  { name: 'ESPN', url: 'https://www.espn.com/espn/rss/news', category: 'sports' },
  { name: 'Sky Sports', url: 'https://www.skysports.com/rss/12040', category: 'sports' },
  { name: 'The Guardian Sport', url: 'https://www.theguardian.com/uk/sport/rss', category: 'sports' },
  { name: 'Marca English', url: 'https://www.marca.com/en/rss/portada.xml', category: 'sports' },

  // Culture — Polish & Worldwide
  { name: 'BBC Culture', url: 'https://www.bbc.com/culture/feed.rss', category: 'culture' },
  { name: 'The Guardian Culture', url: 'https://www.theguardian.com/culture/rss', category: 'culture' },
  { name: 'Artnet News', url: 'https://news.artnet.com/feed', category: 'culture' },
  { name: 'Culture.pl', url: 'https://culture.pl/en/rss.xml', category: 'culture' },

  // Economics & Macro
  { name: 'Reuters Business', url: 'https://www.reutersagency.com/feed/?best-topics=business-finance', category: 'economics' },
  { name: 'ECB Press', url: 'https://www.ecb.europa.eu/rss/press.html', category: 'economics' },
  { name: 'Fed News', url: 'https://www.federalreserve.gov/feeds/press_all.xml', category: 'economics' },
  { name: 'IMF News', url: 'https://www.imf.org/en/News/Rss', category: 'economics' },
  { name: 'World Bank', url: 'https://www.worldbank.org/en/news/all/rss.xml', category: 'economics' },
];

export const WEATHER_LOCATIONS: WeatherLocation[] = [
  { name: 'Pegeia, Cyprus', lat: 34.88, lon: 32.38, timezone: 'Asia/Nicosia' },
  { name: 'Gdańsk, Poland', lat: 54.35, lon: 18.65, timezone: 'Europe/Warsaw' },
];

export const MARKET_TICKERS: MarketTicker[] = [
  { name: 'MSCI World', symbol: 'URTH' },
  { name: 'MSCI Emerging Markets', symbol: 'EEM' },
  { name: 'MSCI Europe', symbol: 'IEUR' },
  { name: 'MSCI Asia Pacific', symbol: 'AAXJ' },
  { name: 'Gold (SPDR)', symbol: 'GLD' },
];

export const CURRENCY_PAIRS: CurrencyPair[] = [
  { from: 'USD', to: 'PLN' },
  { from: 'EUR', to: 'USD' },
];

export const COUNTRIES_OF_INTEREST = ['PL', 'CY', 'NP', 'UA', 'CN', 'DE', 'FR', 'IT', 'ES', 'GB', 'US', 'EU'];

export const CATEGORIES = ['tech_ai', 'climate', 'politics', 'science', 'business', 'health', 'sports', 'culture', 'economics'];

// ──────────────────────────────────────────────────────────────────────────────
// Per-person interest subsections (cycling, lodz, tczew, paphos, …)
//
// Each interest declares its own dedicated RSS feeds plus curation hints for
// the Haiku-based picker in src/interests.ts. These feeds are NEVER merged
// into the shared RSS_FEEDS list — they're fetched separately and only
// rendered on the email of a subscriber listed in SUBSCRIBER_INTERESTS below,
// so they can't leak into anyone else's digest.
//
// To add an interest:
//   1) add an entry to INTERESTS below with feeds + prompt hints
//   2) add the subscriber's email → [interest ids] to SUBSCRIBER_INTERESTS
// ──────────────────────────────────────────────────────────────────────────────

export interface InterestDefinition {
  id: string;
  title: string;       // section header text, e.g. "Cycling"
  emoji: string;       // prepended to the header
  audience: string;    // prompt fragment describing the reader
  prioritize: string;  // bulleted markdown injected into the curation prompt
  skip: string;        // bulleted markdown injected into the curation prompt
  feeds: RssFeedConfig[];
  topN: number;        // how many items to keep after curation
}

export const INTERESTS: Record<string, InterestDefinition> = {
  cycling: {
    id: 'cycling',
    title: 'Cycling',
    emoji: '🚴',
    audience: 'a cycling enthusiast who follows pro road racing and the wider sport',
    prioritize: `- Grand tour / monument / world-tour race results and major race news
- Rider and team news: transfers, retirements, injuries, contract disputes
- UCI governance, doping cases, significant controversies
- Major equipment launches from top brands and UCI rule changes`,
    skip: `- Minor regional, amateur, or junior races
- Thin gear roundups, listicles ("5 best wheels under £500")
- Routine weekly race previews with no new angle
- Generic training-tip or nutrition explainers`,
    feeds: [
      { name: 'Cyclingnews', url: 'https://www.cyclingnews.com/rss/news', category: 'cycling' },
      { name: 'VeloNews', url: 'https://velo.outsideonline.com/feed/', category: 'cycling' },
      { name: 'road.cc', url: 'https://road.cc/rss.xml', category: 'cycling' },
      { name: 'BikeRadar', url: 'https://www.bikeradar.com/feeds/news', category: 'cycling' },
    ],
    topN: 3,
  },
};

// Per-recipient interest opt-in. Keyed by normalized (lowercase) email. A
// subscriber with no entry here gets the untouched digest — zero behaviour
// change. Migrate to KV-backed SubscriberRecord.interests once we add a UI.
export const SUBSCRIBER_INTERESTS: Record<string, string[]> = {
  'frogaczewski@gmail.com': ['cycling'],
};

export const EMAIL_FROM = { email: 'ainews@rogaczewski.me', name: 'AI News Digest' };
export const EMAIL_TO = { email: 'frogaczewski@gmail.com', name: 'Filip Rogaczewski' };
export const EMAIL_TO_PL = [
  { email: 'jarrog@gmail.com', name: 'Jarosław Rogaczewski' },
  { email: 'adytczew@o2.pl', name: 'Adam Dulak' },
  { email: 'bartek.szajkowski@gmail.com', name: 'Bartek Szajkowski' },
  { email: 'enterbios@gmail.com', name: 'Arkadiusz Głowacki' },
  { email: 'mail@danielturczanski.com', name: 'Daniel Turczański' },
  { email: 'konradlazarski@gmail.com', name: 'Konrad Łazarski' },
  { email: 'Robert.sakowski@lifein.pl', name: 'Robert Sakowski' },
  { email: 'frogaczewski@gmail.com', name: 'Filip Rogaczewski' },
  { email: 'p.konczakowski@wp.pl', name: 'Przemysław Kończakowski' },
  { email: 'tszajkowski@wp.pl', name: 'Tomasz Szajkowski' },
  { email: 'madlenaszajkowska@gmail.com', name: 'Madlena Szajkowska' },
  { email: 'jacek@gorcz.pl', name: 'Jacek Gorcz' },
  { email: 'odyapiotr@gmail.com', name: 'Piotr Odya' },
  { email: 'pawel.czapski.pruszak@gmail.com', name: 'Paweł Czapski Pruszak' },
  { email: 'radca.bronk@gmail.com', name: 'Tomasz Bronk' },
  { email: 'lukaszkakoltcz@gmail.com', name: 'Łukasz Kakol' },
  { email: 'tozwa@op.pl', name: 'Tomasz Zwara' },
  { email: 'mabugajewski@gmail.com', name: 'Mariusz Bugajewski' },
  { email: 'dorrog1@gmail.com', name: 'Dorota Rogaczewska' },
  { email: 'mikisak2003@gmail.com', name: 'Mikisak' },
];

export const WMO_WEATHER_CODES: Record<number, string> = {
  0: 'Clear sky',
  1: 'Mainly clear',
  2: 'Partly cloudy',
  3: 'Overcast',
  45: 'Foggy',
  48: 'Depositing rime fog',
  51: 'Light drizzle',
  53: 'Moderate drizzle',
  55: 'Dense drizzle',
  61: 'Slight rain',
  63: 'Moderate rain',
  65: 'Heavy rain',
  71: 'Slight snow fall',
  73: 'Moderate snow fall',
  75: 'Heavy snow fall',
  80: 'Slight rain showers',
  81: 'Moderate rain showers',
  82: 'Violent rain showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm with slight hail',
  99: 'Thunderstorm with heavy hail',
};
