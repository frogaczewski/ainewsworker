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
  { name: 'Globe and Mail', url: 'https://www.theglobeandmail.com/?service=rss', category: 'global' },

  // Western / Liberal-Leaning
  { name: 'The Guardian World', url: 'https://www.theguardian.com/world/rss', category: 'global' },
  { name: 'The Guardian Science', url: 'https://www.theguardian.com/science/rss', category: 'science' },
  { name: 'NPR News', url: 'https://feeds.npr.org/1002/rss.xml', category: 'global' },
  { name: 'ProPublica', url: 'https://feeds.propublica.org/propublica/main', category: 'global' },
  { name: 'Democracy Now', url: 'https://www.democracynow.org/democracynow.rss', category: 'global' },

  // Middle East
  { name: 'Al Jazeera', url: 'https://www.aljazeera.com/xml/rss/all.xml', category: 'global' },
  { name: 'Al Arabiya', url: 'https://english.alarabiya.net/tools/mrss', category: 'global' },

  // Chinese State / Perspective
  { name: 'Xinhua', url: 'http://www.xinhuanet.com/english/rss/worldrss.xml', category: 'global' },
  { name: 'SCMP', url: 'https://www.scmp.com/rss/4/feed', category: 'global' },

  // Russian Perspective
  { name: 'TASS', url: 'https://tass.com/rss/v2.xml', category: 'global' },
  { name: 'Meduza', url: 'https://meduza.io/rss/en/all', category: 'global' },
  { name: 'Moscow Times', url: 'https://www.themoscowtimes.com/rss/news', category: 'global' },

  // Asia-Pacific
  { name: 'NHK World', url: 'https://www3.nhk.or.jp/nhkworld/en/news/list.xml', category: 'global' },
  { name: 'Straits Times', url: 'https://www.straitstimes.com/news/rss.xml', category: 'global' },
  { name: 'Nikkei Asia', url: 'https://asia.nikkei.com/rss/feed/nar', category: 'business' },
  { name: 'Times of India', url: 'https://timesofindia.indiatimes.com/rssfeedstopstories.cms', category: 'global' },
  { name: 'The Hindu', url: 'https://www.thehindu.com/news/international/feeder/default.rss', category: 'global' },

  // Europe / EU
  { name: 'Politico EU', url: 'https://www.politico.eu/feed/', category: 'politics' },
  { name: 'Der Spiegel Intl', url: 'https://www.spiegel.de/international/index.rss', category: 'global' },
  { name: 'El País', url: 'https://feeds.elpais.com/mrss-s/pages/ep/site/english.elpais.com/portada', category: 'global' },

  // Poland
  { name: 'Gazeta Wyborcza', url: 'http://rss.gazeta.pl/pub/rss/gazetawyborcza_kraj.xml', category: 'poland' },
  { name: 'Rzeczpospolita', url: 'https://www.rp.pl/rss_main', category: 'poland' },
  { name: 'Notes From Poland', url: 'https://notesfrompoland.com/feed/', category: 'poland' },

  // Nepal
  { name: 'Himalayan Times', url: 'https://www.thehimalayantimes.com/feed/', category: 'nepal' },

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

export const COUNTRIES_OF_INTEREST = ['PL', 'CY', 'NP', 'CN', 'DE', 'FR', 'IT', 'ES', 'GB', 'US', 'EU'];

export const CATEGORIES = ['tech_ai', 'climate', 'politics', 'science', 'business', 'health'];

export const EMAIL_FROM = { email: 'ainews@rogaczewski.me', name: 'AI News Digest' };
export const EMAIL_TO = { email: 'frogaczewski@gmail.com', name: 'Filip Rogaczewski' };

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
