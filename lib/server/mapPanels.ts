// public.solarpanels: panelvalgene i solkartet (pvmap). Pris per panel etter antall paneler.
export const MAP_PANEL_STEPS = ["0-72", "72-150", "150-300", "300-600", "600-1000", "1000+"] as const;
export type MapPanelStep = (typeof MAP_PANEL_STEPS)[number];

export type MapPanelRow = { id: string; NAVN: string; WATTAGE: string | number; description: string | null } & Record<MapPanelStep, string | number>;

export interface MapPanel {
  id: string;
  name: string;
  watt: number;
  description: string | null;
  /** Kroner per panel, per trinn (antall paneler) */
  prices: Record<MapPanelStep, number>;
}

export const toMapPanel = (r: MapPanelRow): MapPanel => ({
  id: r.id,
  name: r.NAVN,
  watt: Number(r.WATTAGE),
  description: r.description,
  prices: Object.fromEntries(MAP_PANEL_STEPS.map((s) => [s, Number(r[s])])) as Record<MapPanelStep, number>,
});
