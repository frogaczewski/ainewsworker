import { WEATHER_LOCATIONS, WMO_WEATHER_CODES } from './config';
import type { WeatherData, WeatherDay } from './types';

interface OpenMeteoResponse {
  daily: {
    time: string[];
    weather_code: number[];
    temperature_2m_max: number[];
    temperature_2m_min: number[];
  };
}

async function fetchWeatherForLocation(location: { name: string; lat: number; lon: number; timezone: string }): Promise<WeatherData> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${location.lat}&longitude=${location.lon}&daily=weather_code,temperature_2m_max,temperature_2m_min&timezone=${encodeURIComponent(location.timezone)}&forecast_days=3`;

    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await response.json() as OpenMeteoResponse;
    const days: WeatherDay[] = data.daily.time.map((date, i) => ({
      date,
      conditions: WMO_WEATHER_CODES[data.daily.weather_code[i]] || `Code ${data.daily.weather_code[i]}`,
      tempMax: Math.round(data.daily.temperature_2m_max[i]),
      tempMin: Math.round(data.daily.temperature_2m_min[i]),
    }));

    return { location: location.name, days };
  } catch (err) {
    return {
      location: location.name,
      days: [{ date: 'N/A', conditions: 'Weather data temporarily unavailable', tempMax: 0, tempMin: 0 }],
    };
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchWeather(): Promise<WeatherData[]> {
  return Promise.all(WEATHER_LOCATIONS.map(loc => fetchWeatherForLocation(loc)));
}
