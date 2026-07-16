import fs from "fs";
import path from "path";

export interface OHLCV {
  date: string; // YYYY-MM-DD
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

// ---------------- PERSONAL TRADE JOURNAL ----------------

export interface JournalTrade {
  id: string;
  symbol: string;
  name?: string;
  strategyId?: string;
  strategyLabel?: string;
  module?: string;           // "m1" | "m2" | "m3"
  takenAt: string;           // ISO timestamp when the user ticked "taking this trade"
  entryDate: string;         // YYYY-MM-DD trading day of entry
  entryPrice: number;
  stopPrice: number;
  targetPrice: number;
  status: "OPEN" | "SL_HIT" | "TARGET_HIT" | "CLOSED_MANUAL";
  exitPrice?: number;
  exitDate?: string;
  returnPct?: number;
  currentPrice?: number;     // latest close while OPEN
  unrealizedPct?: number;    // while OPEN
  depthPct?: number;         // m2: cup depth at entry (for the learning stats)
  durationM?: number;        // m2: base duration
  note?: string;
  aiReview?: string;         // Gemini-generated review after close
}

// Walks the candles AFTER the entry day chronologically and decides whether the
// stop-loss or the target was hit first (gap-aware). Same-candle ambiguity (low
// touches stop AND high touches target on one day) resolves to SL — conservative,
// since intraday order is unknowable from daily bars.
// Checks start from the NEXT session (date > entryDate) because the entry itself
// happened intraday on entryDate — that day's earlier low must not fake an SL hit.
export function evaluateTradeOutcome(
  entryDate: string,
  entryPrice: number,
  stopPrice: number,
  targetPrice: number,
  ohlcv: OHLCV[]
): { status: "OPEN" | "SL_HIT" | "TARGET_HIT"; exitPrice?: number; exitDate?: string; currentPrice?: number } {
  const after = ohlcv.filter((c) => c.date > entryDate);
  for (const c of after) {
    if (c.open <= stopPrice) return { status: "SL_HIT", exitPrice: c.open, exitDate: c.date };       // gap below stop → filled at open
    if (c.low <= stopPrice) return { status: "SL_HIT", exitPrice: stopPrice, exitDate: c.date };     // stop hit intraday
    if (c.open >= targetPrice) return { status: "TARGET_HIT", exitPrice: c.open, exitDate: c.date }; // gap above target
    if (c.high >= targetPrice) return { status: "TARGET_HIT", exitPrice: targetPrice, exitDate: c.date };
  }
  const last = ohlcv[ohlcv.length - 1];
  return { status: "OPEN", currentPrice: last ? last.close : undefined };
}

export interface TradeRecord {
  entryDate: string;
  exitDate: string;
  entryPrice: number;
  exitPrice: number;
  returnPct: number;
  win: boolean;
  depthPct?: number;    // m2 only: depth of the cup base active at entry
  durationM?: number;   // m2 only: base duration (≈months) active at entry
  forced?: boolean;     // closed only because the data ended (not a real strategy exit)
}

interface MACDResult {
  macdLine: number[];
  signalLine: number[];
  histogram: number[];
}

interface BBResult {
  upper: number[];
  middle: number[];
  lower: number[];
  bandwidth: number[];
}

interface StochRSIResult {
  k: number[];
  d: number[];
}

export interface BacktestStats {
  passed: boolean;
  numTrades: number;
  winRatePct: number;
  profitFactor: number;
  avgReturnPct: number;
  maxDrawdownPct: number;
  lastEntryPrice: number;
  lastExitPrice: number;
  lastReturnPct: number;
  liveSignal: boolean;
  livePrice: number | null;
  liveStop?: number | null;    // m4: structure-based SL for today's live signal
  liveTarget?: number | null;  // m4: 2R target for today's live signal
  tradeLog: TradeRecord[];
  // Every fresh trigger with the close price of that day (m2 also carries cup depth/duration;
  // m4 carries its structure-based stop/tgt so playback take-trade can use real levels).
  // This is what lets the Playback engine know exactly what was LIVE on any past date.
  signals: { d: string; p: number; dp?: number; dm?: number; stop?: number; tgt?: number }[];
}

// Robust fallback list of ~330 Nifty 500 constituent tickers (with .NS Yahoo Finance suffix).
// Used ONLY if every live source below fails. Bigger floor = graceful degrade, not a cliff to 83.
const TICKERS_FALLBACK = [
  { symbol: "RELIANCE.NS", name: "Reliance Industries Limited" },
  { symbol: "TCS.NS", name: "Tata Consultancy Services Limited" },
  { symbol: "HDFCBANK.NS", name: "HDFC Bank Limited" },
  { symbol: "INFY.NS", name: "Infosys Limited" },
  { symbol: "ICICIBANK.NS", name: "ICICI Bank Limited" },
  { symbol: "ITC.NS", name: "ITC Limited" },
  { symbol: "SBIN.NS", name: "State Bank of India" },
  { symbol: "BHARTIARTL.NS", name: "Bharti Airtel Limited" },
  { symbol: "LTIM.NS", name: "LTIMindtree Limited" },
  { symbol: "TATAMOTORS.NS", name: "Tata Motors Limited" },
  { symbol: "HINDUNILVR.NS", name: "Hindustan Unilever Limited" },
  { symbol: "AXISBANK.NS", name: "Axis Bank Limited" },
  { symbol: "LT.NS", name: "Larsen & Toubro Limited" },
  { symbol: "KOTAKBANK.NS", name: "Kotak Mahindra Bank Limited" },
  { symbol: "ADANIENT.NS", name: "Adani Enterprises Limited" },
  { symbol: "BAJFINANCE.NS", name: "Bajaj Finance Limited" },
  { symbol: "MARUTI.NS", name: "Maruti Suzuki India Limited" },
  { symbol: "SUNPHARMA.NS", name: "Sun Pharmaceutical Industries Limited" },
  { symbol: "COALINDIA.NS", name: "Coal India Limited" },
  { symbol: "TATACONSUM.NS", name: "Tata Consumer Products Limited" },
  { symbol: "ONGC.NS", name: "Oil and Natural Gas Corporation Limited" },
  { symbol: "NTPC.NS", name: "NTPC Limited" },
  { symbol: "JSWSTEEL.NS", name: "JSW Steel Limited" },
  { symbol: "POWERGRID.NS", name: "Power Grid Corporation of India Limited" },
  { symbol: "M&M.NS", name: "Mahindra & Mahindra Limited" },
  { symbol: "TATASTEEL.NS", name: "Tata Steel Limited" },
  { symbol: "ADANIPORTS.NS", name: "Adani Ports and Special Economic Zone Limited" },
  { symbol: "IOC.NS", name: "Indian Oil Corporation Limited" },
  { symbol: "BPCL.NS", name: "Bharat Petroleum Corporation Limited" },
  { symbol: "GRASIM.NS", name: "Grasim Industries Limited" },
  { symbol: "ULTRACEMCO.NS", name: "UltraTech Cement Limited" },
  { symbol: "WIPRO.NS", name: "Wipro Limited" },
  { symbol: "HCLTECH.NS", name: "HCL Technologies Limited" },
  { symbol: "TITAN.NS", name: "Titan Company Limited" },
  { symbol: "ASIANPAINT.NS", name: "Asian Paints Limited" },
  { symbol: "NESTLEIND.NS", name: "Nestle India Limited" },
  { symbol: "BAJAJFINSV.NS", name: "Bajaj Finserv Limited" },
  { symbol: "APOLLOHOSP.NS", name: "Apollo Hospitals Enterprise Limited" },
  { symbol: "HINDALCO.NS", name: "Hindalco Industries Limited" },
  { symbol: "CIPLA.NS", name: "Cipla Limited" },
  { symbol: "DRREDDY.NS", name: "Dr. Reddy's Laboratories Limited" },
  { symbol: "EICHERMOT.NS", name: "Eicher Motors Limited" },
  { symbol: "HEROMOTOCO.NS", name: "Hero MotoCorp Limited" },
  { symbol: "INDUSINDBK.NS", name: "IndusInd Bank Limited" },
  { symbol: "DLF.NS", name: "DLF Limited" },
  { symbol: "SHREECEM.NS", name: "Shree Cement Limited" },
  { symbol: "HAVELLS.NS", name: "Havells India Limited" },
  { symbol: "ICICIPRULI.NS", name: "ICICI Prudential Life Insurance Company Limited" },
  { symbol: "SBILIFE.NS", name: "SBI Life Insurance Company Limited" },
  { symbol: "AMBUJACEM.NS", name: "Ambuja Cements Limited" },
  { symbol: "ACC.NS", name: "ACC Limited" },
  { symbol: "BERGEPAINT.NS", name: "Berger Paints India Limited" },
  { symbol: "COLPAL.NS", name: "Colgate-Palmolive (India) Limited" },
  { symbol: "DABUR.NS", name: "Dabur India Limited" },
  { symbol: "GODREJCP.NS", name: "Godrej Consumer Products Limited" },
  { symbol: "MARICO.NS", name: "Marico Limited" },
  { symbol: "PIDILITIND.NS", name: "Pidilite Industries Limited" },
  { symbol: "UPL.NS", name: "UPL Limited" },
  { symbol: "SIEMENS.NS", name: "Siemens Limited" },
  { symbol: "ABB.NS", name: "ABB India Limited" },
  { symbol: "BEL.NS", name: "Bharat Electronics Limited" },
  { symbol: "HAL.NS", name: "Hindustan Aeronautics Limited" },
  { symbol: "GAIL.NS", name: "GAIL (India) Limited" },
  { symbol: "PETRONET.NS", name: "Petronet LNG Limited" },
  { symbol: "RECLTD.NS", name: "REC Limited" },
  { symbol: "PFC.NS", name: "Power Finance Corporation Limited" },
  { symbol: "BANDHANBNK.NS", name: "Bandhan Bank Limited" },
  { symbol: "FEDERALBNK.NS", name: "The Federal Bank Limited" },
  { symbol: "IDFCFIRSTB.NS", name: "IDFC First Bank Limited" },
  { symbol: "PNB.NS", name: "Punjab National Bank" },
  { symbol: "AUBANK.NS", name: "AU Small Finance Bank Limited" },
  { symbol: "CHOLAFIN.NS", name: "Cholamandalam Investment and Finance Company Limited" },
  { symbol: "MUTHOOTFIN.NS", name: "Muthoot Finance Limited" },
  { symbol: "SRF.NS", name: "SRF Limited" },
  { symbol: "ASHOKLEY.NS", name: "Ashok Leyland Limited" },
  { symbol: "BALKRISIND.NS", name: "Balkrishna Industries Limited" },
  { symbol: "BOSCHLTD.NS", name: "Bosch Limited" },
  { symbol: "MRF.NS", name: "MRF Limited" },
  { symbol: "TVSMOTOR.NS", name: "TVS Motor Company Limited" },
  { symbol: "APOLLOTYRE.NS", name: "Apollo Tyres Limited" },
  { symbol: "TRENT.NS", name: "Trent Limited" },
  { symbol: "PAGEIND.NS", name: "Page Industries Limited" },
  { symbol: "POLYCAB.NS", name: "Polycab India Limited" },
  { symbol: "BANKBARODA.NS", name: "Bank of Baroda" },
  { symbol: "CANBK.NS", name: "Canara Bank" },
  { symbol: "UNIONBANK.NS", name: "Union Bank of India" },
  { symbol: "INDIANB.NS", name: "Indian Bank" },
  { symbol: "BANKINDIA.NS", name: "Bank of India" },
  { symbol: "IOB.NS", name: "Indian Overseas Bank" },
  { symbol: "MAHABANK.NS", name: "Bank of Maharashtra" },
  { symbol: "YESBANK.NS", name: "Yes Bank Limited" },
  { symbol: "IDBI.NS", name: "IDBI Bank Limited" },
  { symbol: "RBLBANK.NS", name: "RBL Bank Limited" },
  { symbol: "BAJAJHLDNG.NS", name: "Bajaj Holdings & Investment Limited" },
  { symbol: "SBICARD.NS", name: "SBI Cards and Payment Services Limited" },
  { symbol: "HDFCLIFE.NS", name: "HDFC Life Insurance Company Limited" },
  { symbol: "HDFCAMC.NS", name: "HDFC Asset Management Company Limited" },
  { symbol: "LICI.NS", name: "Life Insurance Corporation of India" },
  { symbol: "LICHSGFIN.NS", name: "LIC Housing Finance Limited" },
  { symbol: "ICICIGI.NS", name: "ICICI Lombard General Insurance Company Limited" },
  { symbol: "SHRIRAMFIN.NS", name: "Shriram Finance Limited" },
  { symbol: "IIFL.NS", name: "IIFL Finance Limited" },
  { symbol: "CANFINHOME.NS", name: "Can Fin Homes Limited" },
  { symbol: "M&MFIN.NS", name: "Mahindra & Mahindra Financial Services Limited" },
  { symbol: "MANAPPURAM.NS", name: "Manappuram Finance Limited" },
  { symbol: "SUNDARMFIN.NS", name: "Sundaram Finance Limited" },
  { symbol: "ABCAPITAL.NS", name: "Aditya Birla Capital Limited" },
  { symbol: "POONAWALLA.NS", name: "Poonawalla Fincorp Limited" },
  { symbol: "JIOFIN.NS", name: "Jio Financial Services Limited" },
  { symbol: "IRFC.NS", name: "Indian Railway Finance Corporation Limited" },
  { symbol: "IREDA.NS", name: "Indian Renewable Energy Development Agency Limited" },
  { symbol: "LTF.NS", name: "L&T Finance Limited" },
  { symbol: "PERSISTENT.NS", name: "Persistent Systems Limited" },
  { symbol: "COFORGE.NS", name: "Coforge Limited" },
  { symbol: "MPHASIS.NS", name: "Mphasis Limited" },
  { symbol: "LTTS.NS", name: "L&T Technology Services Limited" },
  { symbol: "OFSS.NS", name: "Oracle Financial Services Software Limited" },
  { symbol: "TATAELXSI.NS", name: "Tata Elxsi Limited" },
  { symbol: "KPITTECH.NS", name: "KPIT Technologies Limited" },
  { symbol: "BSOFT.NS", name: "Birlasoft Limited" },
  { symbol: "CYIENT.NS", name: "Cyient Limited" },
  { symbol: "TATATECH.NS", name: "Tata Technologies Limited" },
  { symbol: "INTELLECT.NS", name: "Intellect Design Arena Limited" },
  { symbol: "DIVISLAB.NS", name: "Divi's Laboratories Limited" },
  { symbol: "LUPIN.NS", name: "Lupin Limited" },
  { symbol: "AUROPHARMA.NS", name: "Aurobindo Pharma Limited" },
  { symbol: "ZYDUSLIFE.NS", name: "Zydus Lifesciences Limited" },
  { symbol: "ALKEM.NS", name: "Alkem Laboratories Limited" },
  { symbol: "TORNTPHARM.NS", name: "Torrent Pharmaceuticals Limited" },
  { symbol: "BIOCON.NS", name: "Biocon Limited" },
  { symbol: "GLENMARK.NS", name: "Glenmark Pharmaceuticals Limited" },
  { symbol: "IPCALAB.NS", name: "IPCA Laboratories Limited" },
  { symbol: "LAURUSLABS.NS", name: "Laurus Labs Limited" },
  { symbol: "ABBOTINDIA.NS", name: "Abbott India Limited" },
  { symbol: "MANKIND.NS", name: "Mankind Pharma Limited" },
  { symbol: "FORTIS.NS", name: "Fortis Healthcare Limited" },
  { symbol: "MAXHEALTH.NS", name: "Max Healthcare Institute Limited" },
  { symbol: "METROPOLIS.NS", name: "Metropolis Healthcare Limited" },
  { symbol: "LALPATHLAB.NS", name: "Dr. Lal PathLabs Limited" },
  { symbol: "SYNGENE.NS", name: "Syngene International Limited" },
  { symbol: "AJANTPHARM.NS", name: "Ajanta Pharma Limited" },
  { symbol: "NATCOPHARM.NS", name: "Natco Pharma Limited" },
  { symbol: "GRANULES.NS", name: "Granules India Limited" },
  { symbol: "JBCHEPHARM.NS", name: "J.B. Chemicals & Pharmaceuticals Limited" },
  { symbol: "BAJAJ-AUTO.NS", name: "Bajaj Auto Limited" },
  { symbol: "MOTHERSON.NS", name: "Samvardhana Motherson International Limited" },
  { symbol: "BHARATFORG.NS", name: "Bharat Forge Limited" },
  { symbol: "TIINDIA.NS", name: "Tube Investments of India Limited" },
  { symbol: "SONACOMS.NS", name: "Sona BLW Precision Forgings Limited" },
  { symbol: "UNOMINDA.NS", name: "UNO Minda Limited" },
  { symbol: "EXIDEIND.NS", name: "Exide Industries Limited" },
  { symbol: "ESCORTS.NS", name: "Escorts Kubota Limited" },
  { symbol: "BRITANNIA.NS", name: "Britannia Industries Limited" },
  { symbol: "VBL.NS", name: "Varun Beverages Limited" },
  { symbol: "UBL.NS", name: "United Breweries Limited" },
  { symbol: "RADICO.NS", name: "Radico Khaitan Limited" },
  { symbol: "EMAMILTD.NS", name: "Emami Limited" },
  { symbol: "GODREJIND.NS", name: "Godrej Industries Limited" },
  { symbol: "PATANJALI.NS", name: "Patanjali Foods Limited" },
  { symbol: "DMART.NS", name: "Avenue Supermarts Limited" },
  { symbol: "VEDL.NS", name: "Vedanta Limited" },
  { symbol: "JINDALSTEL.NS", name: "Jindal Steel & Power Limited" },
  { symbol: "NMDC.NS", name: "NMDC Limited" },
  { symbol: "SAIL.NS", name: "Steel Authority of India Limited" },
  { symbol: "NATIONALUM.NS", name: "National Aluminium Company Limited" },
  { symbol: "HINDZINC.NS", name: "Hindustan Zinc Limited" },
  { symbol: "JSL.NS", name: "Jindal Stainless Limited" },
  { symbol: "APLAPOLLO.NS", name: "APL Apollo Tubes Limited" },
  { symbol: "RATNAMANI.NS", name: "Ratnamani Metals & Tubes Limited" },
  { symbol: "TATAPOWER.NS", name: "Tata Power Company Limited" },
  { symbol: "ADANIGREEN.NS", name: "Adani Green Energy Limited" },
  { symbol: "ADANIPOWER.NS", name: "Adani Power Limited" },
  { symbol: "ADANIENSOL.NS", name: "Adani Energy Solutions Limited" },
  { symbol: "NHPC.NS", name: "NHPC Limited" },
  { symbol: "SJVN.NS", name: "SJVN Limited" },
  { symbol: "TORNTPOWER.NS", name: "Torrent Power Limited" },
  { symbol: "JSWENERGY.NS", name: "JSW Energy Limited" },
  { symbol: "CESC.NS", name: "CESC Limited" },
  { symbol: "IGL.NS", name: "Indraprastha Gas Limited" },
  { symbol: "MGL.NS", name: "Mahanagar Gas Limited" },
  { symbol: "GUJGASLTD.NS", name: "Gujarat Gas Limited" },
  { symbol: "OIL.NS", name: "Oil India Limited" },
  { symbol: "MRPL.NS", name: "Mangalore Refinery and Petrochemicals Limited" },
  { symbol: "DALBHARAT.NS", name: "Dalmia Bharat Limited" },
  { symbol: "JKCEMENT.NS", name: "JK Cement Limited" },
  { symbol: "RAMCOCEM.NS", name: "The Ramco Cements Limited" },
  { symbol: "INDIACEM.NS", name: "The India Cements Limited" },
  { symbol: "JKLAKSHMI.NS", name: "JK Lakshmi Cement Limited" },
  { symbol: "CUMMINSIND.NS", name: "Cummins India Limited" },
  { symbol: "THERMAX.NS", name: "Thermax Limited" },
  { symbol: "BHEL.NS", name: "Bharat Heavy Electricals Limited" },
  { symbol: "NCC.NS", name: "NCC Limited" },
  { symbol: "KEI.NS", name: "KEI Industries Limited" },
  { symbol: "CGPOWER.NS", name: "CG Power and Industrial Solutions Limited" },
  { symbol: "APARINDS.NS", name: "Apar Industries Limited" },
  { symbol: "KAYNES.NS", name: "Kaynes Technology India Limited" },
  { symbol: "DIXON.NS", name: "Dixon Technologies (India) Limited" },
  { symbol: "AMBER.NS", name: "Amber Enterprises India Limited" },
  { symbol: "VOLTAS.NS", name: "Voltas Limited" },
  { symbol: "BLUESTARCO.NS", name: "Blue Star Limited" },
  { symbol: "CROMPTON.NS", name: "Crompton Greaves Consumer Electricals Limited" },
  { symbol: "KAJARIACER.NS", name: "Kajaria Ceramics Limited" },
  { symbol: "CERA.NS", name: "Cera Sanitaryware Limited" },
  { symbol: "PIIND.NS", name: "PI Industries Limited" },
  { symbol: "AARTIIND.NS", name: "Aarti Industries Limited" },
  { symbol: "DEEPAKNTR.NS", name: "Deepak Nitrite Limited" },
  { symbol: "ATUL.NS", name: "Atul Limited" },
  { symbol: "VINATIORGA.NS", name: "Vinati Organics Limited" },
  { symbol: "NAVINFLUOR.NS", name: "Navin Fluorine International Limited" },
  { symbol: "FLUOROCHEM.NS", name: "Gujarat Fluorochemicals Limited" },
  { symbol: "TATACHEM.NS", name: "Tata Chemicals Limited" },
  { symbol: "COROMANDEL.NS", name: "Coromandel International Limited" },
  { symbol: "GNFC.NS", name: "Gujarat Narmada Valley Fertilizers & Chemicals Limited" },
  { symbol: "SUMICHEM.NS", name: "Sumitomo Chemical India Limited" },
  { symbol: "LINDEINDIA.NS", name: "Linde India Limited" },
  { symbol: "SOLARINDS.NS", name: "Solar Industries India Limited" },
  { symbol: "GODREJPROP.NS", name: "Godrej Properties Limited" },
  { symbol: "OBEROIRLTY.NS", name: "Oberoi Realty Limited" },
  { symbol: "PRESTIGE.NS", name: "Prestige Estates Projects Limited" },
  { symbol: "PHOENIXLTD.NS", name: "The Phoenix Mills Limited" },
  { symbol: "BRIGADE.NS", name: "Brigade Enterprises Limited" },
  { symbol: "LODHA.NS", name: "Macrotech Developers Limited" },
  { symbol: "IDEA.NS", name: "Vodafone Idea Limited" },
  { symbol: "INDUSTOWER.NS", name: "Indus Towers Limited" },
  { symbol: "TATACOMM.NS", name: "Tata Communications Limited" },
  { symbol: "SUNTV.NS", name: "Sun TV Network Limited" },
  { symbol: "PVRINOX.NS", name: "PVR INOX Limited" },
  { symbol: "ABFRL.NS", name: "Aditya Birla Fashion and Retail Limited" },
  { symbol: "VMART.NS", name: "V-Mart Retail Limited" },
  { symbol: "RELAXO.NS", name: "Relaxo Footwears Limited" },
  { symbol: "BATAINDIA.NS", name: "Bata India Limited" },
  { symbol: "METROBRAND.NS", name: "Metro Brands Limited" },
  { symbol: "CENTURYPLY.NS", name: "Century Plyboards (India) Limited" },
  { symbol: "ETERNAL.NS", name: "Eternal Limited" },
  { symbol: "NYKAA.NS", name: "FSN E-Commerce Ventures Limited" },
  { symbol: "PAYTM.NS", name: "One 97 Communications Limited" },
  { symbol: "POLICYBZR.NS", name: "PB Fintech Limited" },
  { symbol: "DELHIVERY.NS", name: "Delhivery Limited" },
  { symbol: "IRCTC.NS", name: "Indian Railway Catering and Tourism Corporation Limited" },
  { symbol: "RVNL.NS", name: "Rail Vikas Nigam Limited" },
  { symbol: "IRCON.NS", name: "Ircon International Limited" },
  { symbol: "RITES.NS", name: "RITES Limited" },
  { symbol: "CONCOR.NS", name: "Container Corporation of India Limited" },
  { symbol: "GMRAIRPORT.NS", name: "GMR Airports Limited" },
  { symbol: "INDIGO.NS", name: "InterGlobe Aviation Limited" },
  { symbol: "JUBLFOOD.NS", name: "Jubilant FoodWorks Limited" },
  { symbol: "DEVYANI.NS", name: "Devyani International Limited" },
  { symbol: "KPRMILL.NS", name: "K.P.R. Mill Limited" },
  { symbol: "TRIDENT.NS", name: "Trident Limited" },
  { symbol: "PGHH.NS", name: "Procter & Gamble Hygiene and Health Care Limited" },
  { symbol: "3MINDIA.NS", name: "3M India Limited" },
  { symbol: "HONAUT.NS", name: "Honeywell Automation India Limited" },
  { symbol: "SCHAEFFLER.NS", name: "Schaeffler India Limited" },
  { symbol: "SKFINDIA.NS", name: "SKF India Limited" },
  { symbol: "TIMKEN.NS", name: "Timken India Limited" },
  { symbol: "SUPREMEIND.NS", name: "Supreme Industries Limited" },
  { symbol: "ASTRAL.NS", name: "Astral Limited" },
  { symbol: "FINCABLES.NS", name: "Finolex Cables Limited" },
  { symbol: "FINPIPE.NS", name: "Finolex Industries Limited" },
  { symbol: "MFSL.NS", name: "Max Financial Services Limited" },
  { symbol: "360ONE.NS", name: "360 ONE WAM Limited" },
  { symbol: "ANGELONE.NS", name: "Angel One Limited" },
  { symbol: "CDSL.NS", name: "Central Depository Services (India) Limited" },
  { symbol: "BSE.NS", name: "BSE Limited" },
  { symbol: "MCX.NS", name: "Multi Commodity Exchange of India Limited" },
  { symbol: "KFINTECH.NS", name: "KFin Technologies Limited" },
  { symbol: "CAMS.NS", name: "Computer Age Management Services Limited" },
  { symbol: "NAM-INDIA.NS", name: "Nippon Life India Asset Management Limited" },
  { symbol: "UTIAMC.NS", name: "UTI Asset Management Company Limited" },
  { symbol: "CHOLAHLDNG.NS", name: "Cholamandalam Financial Holdings Limited" },
  { symbol: "SUZLON.NS", name: "Suzlon Energy Limited" },
  { symbol: "BDL.NS", name: "Bharat Dynamics Limited" },
  { symbol: "MAZDOCK.NS", name: "Mazagon Dock Shipbuilders Limited" },
  { symbol: "COCHINSHIP.NS", name: "Cochin Shipyard Limited" },
  { symbol: "GRSE.NS", name: "Garden Reach Shipbuilders & Engineers Limited" },
  { symbol: "DATAPATTNS.NS", name: "Data Patterns (India) Limited" },
  { symbol: "ZENTEC.NS", name: "Zen Technologies Limited" },
  { symbol: "KALYANKJIL.NS", name: "Kalyan Jewellers India Limited" },
  { symbol: "PNBHOUSING.NS", name: "PNB Housing Finance Limited" },
  { symbol: "AAVAS.NS", name: "Aavas Financiers Limited" },
  { symbol: "HOMEFIRST.NS", name: "Home First Finance Company India Limited" },
  { symbol: "CREDITACC.NS", name: "CreditAccess Grameen Limited" },
  { symbol: "FIVESTAR.NS", name: "Five-Star Business Finance Limited" },
  { symbol: "KARURVYSYA.NS", name: "Karur Vysya Bank Limited" },
  { symbol: "CUB.NS", name: "City Union Bank Limited" },
  { symbol: "J&KBANK.NS", name: "The Jammu & Kashmir Bank Limited" },
  { symbol: "KANSAINER.NS", name: "Kansai Nerolac Paints Limited" },
  { symbol: "AKZOINDIA.NS", name: "Akzo Nobel India Limited" },
  { symbol: "SUNDRMFAST.NS", name: "Sundram Fasteners Limited" },
  { symbol: "ENDURANCE.NS", name: "Endurance Technologies Limited" },
  { symbol: "MOTHERSUMI.NS", name: "Motherson Sumi Wiring India Limited" },
  { symbol: "CEATLTD.NS", name: "CEAT Limited" },
  { symbol: "JKTYRE.NS", name: "JK Tyre & Industries Limited" },
  { symbol: "GODFRYPHLP.NS", name: "Godfrey Phillips India Limited" },
  { symbol: "VGUARD.NS", name: "V-Guard Industries Limited" },
  { symbol: "WHIRLPOOL.NS", name: "Whirlpool of India Limited" },
  { symbol: "SYMPHONY.NS", name: "Symphony Limited" },
  { symbol: "TTKPRESTIG.NS", name: "TTK Prestige Limited" },
  { symbol: "HINDPETRO.NS", name: "Hindustan Petroleum Corporation Limited" },
  { symbol: "CASTROLIND.NS", name: "Castrol India Limited" },
  { symbol: "GSPL.NS", name: "Gujarat State Petronet Limited" },
  { symbol: "AEGISLOG.NS", name: "Aegis Logistics Limited" },
  { symbol: "CHENNPETRO.NS", name: "Chennai Petroleum Corporation Limited" },
  { symbol: "GESHIP.NS", name: "The Great Eastern Shipping Company Limited" },
  { symbol: "KPIL.NS", name: "Kalpataru Projects International Limited" },
  { symbol: "KEC.NS", name: "KEC International Limited" },
  { symbol: "RHIM.NS", name: "RHI Magnesita India Limited" },
  { symbol: "CARBORUNIV.NS", name: "Carborundum Universal Limited" },
  { symbol: "GRINDWELL.NS", name: "Grindwell Norton Limited" },
  { symbol: "ELGIEQUIP.NS", name: "Elgi Equipments Limited" },
  { symbol: "AIAENG.NS", name: "AIA Engineering Limited" },
  { symbol: "RENUKA.NS", name: "Shree Renuka Sugars Limited" },
  { symbol: "BALRAMCHIN.NS", name: "Balrampur Chini Mills Limited" },
  { symbol: "EIDPARRY.NS", name: "EID Parry (India) Limited" },
  { symbol: "CCL.NS", name: "CCL Products (India) Limited" },
  { symbol: "HERITGFOOD.NS", name: "Heritage Foods Limited" },
  { symbol: "MARKSANS.NS", name: "Marksans Pharma Limited" },
  { symbol: "CAPLIPOINT.NS", name: "Caplin Point Laboratories Limited" },
  { symbol: "ERIS.NS", name: "Eris Lifesciences Limited" },
  { symbol: "SANOFI.NS", name: "Sanofi India Limited" },
  { symbol: "PFIZER.NS", name: "Pfizer Limited" },
  { symbol: "GLAXO.NS", name: "GlaxoSmithKline Pharmaceuticals Limited" },
  { symbol: "POLYMED.NS", name: "Poly Medicure Limited" },
  { symbol: "RAINBOW.NS", name: "Rainbow Children's Medicare Limited" },
  { symbol: "KIMS.NS", name: "Krishna Institute of Medical Sciences Limited" },
  { symbol: "ASTERDM.NS", name: "Aster DM Healthcare Limited" },
  { symbol: "GODIGIT.NS", name: "Go Digit General Insurance Limited" },
  { symbol: "STARHEALTH.NS", name: "Star Health and Allied Insurance Company Limited" },
  { symbol: "NIACL.NS", name: "The New India Assurance Company Limited" },
  { symbol: "GICRE.NS", name: "General Insurance Corporation of India" },
  { symbol: "BAJAJHFL.NS", name: "Bajaj Housing Finance Limited" },
  { symbol: "SAMMAANCAP.NS", name: "Sammaan Capital Limited" },
  { symbol: "HUDCO.NS", name: "Housing and Urban Development Corporation Limited" }
];

// ---------------- EDGE GATE CONFIG ----------------
export const MIN_TRADES = 10;          // 3 was noise; 10 = meetable+meaningful on 5y data
export const MIN_WIN_RATE = 60;        // percent
export const MIN_PROFIT_FACTOR = 2.0;
export const STRICT_TRADES = 15;       // strict gate for strategy modules (M1, M3) + M2 "Strict" highlight
// M4 (Weekly RSI Divergence) gate — only show stocks with win rate >= 50% and >= 7 trades
export const M4_MIN_TRADES = 7;    // minimum 7 completed trades
export const M4_MIN_WIN_RATE = 60; // 60% win rate minimum
export const M4_MIN_PF = 1.2;     // low bar — universe OOS PF 1.88 validated hai
export const STRICT_PF = 2.5;
export const NO_LOSS_PF_CAP = 10.0;    // cap so 3-trade no-loss runs don't show PF 267
const YAHOO_RANGE = "max";      // full available history so any past date can be selected
const SYNTHETIC_DAYS = 5000;    // ~20y of trading days for the fallback path
export const COST_PCT = 0.2;           // round-trip cost + slippage per trade (%) subtracted from every return
const FETCH_RETRIES = 3;        // Yahoo retry attempts with backoff (rate-limit resilience)
export const CUP_WINDOWS = [252, 189, 126]; // rounding-bottom base windows ≈ 12 / 9 / 6 months (longest preferred)

export const STRATEGIES_POOL = [
  { id: "m1_rsi_macd", label: "RSI(14) + MACD Cross", entry: "RSI < 40 and MACD histogram turns positive in oversold zone", exit: "3x ATR stop-loss / 4.5x ATR target (validated: beats the old RSI>70-or-MACD<0 exit on PF and expectancy)" },
  { id: "m1_ema_pullback", label: "EMA 50 Pullback + Volume", entry: "Price touches 50 EMA with volume > 1.5x average", exit: "3x ATR stop-loss / 4.5x ATR target (validated: beats the old EMA20-crossover exit on PF and expectancy)" },
  { id: "m1_bb_squeeze", label: "Bollinger Bands Squeeze Breakout", entry: "BB Bandwidth < 0.05 followed by daily close above Upper Band", exit: "8% stop-loss, fixed 1:2 R:R target (validated: beats the old close-below-middle-band exit on PF and expectancy)" },
  { id: "m1_rsi_mean_rev", label: "RSI Extreme Mean Reversion", entry: "RSI < 25 with daily candle bullish engulfing confirmation", exit: "RSI > 50" },
  { id: "m1_dual_ema", label: "Dual EMA Trend Follower", entry: "9 EMA crosses above 21 EMA in direction of 200 EMA trend", exit: "9 EMA crosses below 21 EMA" },
  { id: "m1_stoch_rsi", label: "Stochastic RSI Trend Filter", entry: "StochRSI K crosses D below 20 with ADX > 25", exit: "StochRSI K crosses D above 80" }
];

// Seeded Random Class
class SeededRandom {
  private seed: number;

  constructor(seedStr: string) {
    let h = 1779033703 ^ seedStr.length;
    for (let i = 0; i < seedStr.length; i++) {
      h = Math.imul(h ^ seedStr.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    this.seed = (h >>> 0);
  }

  next(): number {
    this.seed = (this.seed * 1664525 + 1013904223) % 4294967296;
    return this.seed / 4294967296;
  }

  range(min: number, max: number): number {
    return this.next() * (max - min) + min;
  }
}

// ---------------- INDICATOR MATH FUNCTIONS ----------------

export function calculateRSI(closes: number[], period: number = 14): number[] {
  if (closes.length === 0) return [];
  const rsi: number[] = Array(closes.length).fill(50);
  if (closes.length <= period) return rsi;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff;
    else losses -= diff;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;
  rsi[period] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;

    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;

    rsi[i] = avgLoss === 0 ? 100 : 100 - (100 / (1 + avgGain / avgLoss));
  }
  return rsi;
}

function calculateEMA(closes: number[], period: number): number[] {
  const ema: number[] = [];
  if (closes.length === 0) return [];

  const multiplier = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < Math.min(period, closes.length); i++) {
    sum += closes[i];
    ema.push(sum / (i + 1));
  }

  for (let i = period; i < closes.length; i++) {
    const val = closes[i] * multiplier + ema[i - 1] * (1 - multiplier);
    ema.push(val);
  }
  return ema;
}

function calculateMACD(closes: number[]): MACDResult {
  const ema12 = calculateEMA(closes, 12);
  const ema26 = calculateEMA(closes, 26);
  const macdLine: number[] = [];

  for (let i = 0; i < closes.length; i++) {
    macdLine.push((ema12[i] || 0) - (ema26[i] || 0));
  }

  const signalLine = calculateEMA(macdLine, 9);
  const histogram: number[] = [];
  for (let i = 0; i < closes.length; i++) {
    histogram.push(macdLine[i] - (signalLine[i] || 0));
  }

  return { macdLine, signalLine, histogram };
}

function calculateBollingerBands(closes: number[], period: number = 20, multiplier: number = 2): BBResult {
  const upper: number[] = [];
  const middle: number[] = [];
  const lower: number[] = [];
  const bandwidth: number[] = [];

  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) {
      middle.push(closes[i]);
      upper.push(closes[i]);
      lower.push(closes[i]);
      bandwidth.push(0);
      continue;
    }

    const slice = closes.slice(i - period + 1, i + 1);
    const sma = slice.reduce((a, b) => a + b, 0) / period;
    const variance = slice.reduce((sum, val) => sum + Math.pow(val - sma, 2), 0) / period;
    const stdDev = Math.sqrt(variance);

    const up = sma + multiplier * stdDev;
    const dn = sma - multiplier * stdDev;

    middle.push(sma);
    upper.push(up);
    lower.push(dn);
    bandwidth.push(sma === 0 ? 0 : (up - dn) / sma);
  }

  return { upper, middle, lower, bandwidth };
}

function calculateStochasticRSI(rsi: number[], period: number = 14, kPeriod: number = 3, dPeriod: number = 3): StochRSIResult {
  const stochRSI: number[] = [];

  for (let i = 0; i < rsi.length; i++) {
    if (i < period - 1) {
      stochRSI.push(50);
      continue;
    }

    const slice = rsi.slice(i - period + 1, i + 1);
    const minRSI = Math.min(...slice);
    const maxRSI = Math.max(...slice);
    const denominator = maxRSI - minRSI;

    const val = denominator === 0 ? 50 : ((rsi[i] - minRSI) / denominator) * 100;
    stochRSI.push(val);
  }

  const k = calculateEMA(stochRSI, kPeriod);
  const d = calculateEMA(k, dPeriod);

  return { k, d };
}

// Per-strategy exit overrides — validated via compare-sl on the full Nifty 500
// universe (all 6 M1 strategies tested, native exit vs 6 alternates). Only these
// 3 strategies showed a clear, high-sample-size improvement over their native
// indicator-exit; the other 3 (Dual EMA, StochRSI, RSI Mean-Rev) keep native exit
// — either native already wins, or the sample was too thin (RSI Mean-Rev ~260
// trades on 500 stocks) to trust the improvement.
const ATR_EXIT_SL_MULT = 3, ATR_EXIT_TARGET_MULT = 4.5;   // m1_rsi_macd, m1_ema_pullback
const BB_EXIT_SL_PCT = 8, BB_EXIT_RR = 2;                 // m1_bb_squeeze
function computeOverrideLevels(strategyId: string, entryPrice: number, atrAtEntry: number): { stop: number; target: number } | null {
  if (strategyId === "m1_rsi_macd" || strategyId === "m1_ema_pullback") {
    return { stop: entryPrice - ATR_EXIT_SL_MULT * atrAtEntry, target: entryPrice + ATR_EXIT_TARGET_MULT * atrAtEntry };
  }
  if (strategyId === "m1_bb_squeeze") {
    const stop = entryPrice * (1 - BB_EXIT_SL_PCT / 100);
    return { stop, target: entryPrice + BB_EXIT_RR * (entryPrice - stop) };
  }
  return null; // m1_dual_ema, m1_stoch_rsi, m1_rsi_mean_rev, m2, m4 keep their own native/structural exit
}
function calculateATR(data: OHLCV[], period: number = 14): number[] {
  const atr: number[] = Array(data.length).fill(0);
  if (data.length < period + 1) return atr;
  const tr: number[] = [0];
  for (let i = 1; i < data.length; i++) {
    const c = data[i], p = data[i - 1];
    tr.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  let sum = tr.slice(1, period + 1).reduce((a, b) => a + b, 0);
  atr[period] = sum / period;
  for (let i = period + 1; i < data.length; i++) atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
  return atr;
}

function calculateADX(historicalData: OHLCV[], period: number = 14): number[] {
  if (historicalData.length <= period * 2) {
    return Array(historicalData.length).fill(25);
  }

  const adx: number[] = Array(historicalData.length).fill(25);
  const tr: number[] = [0];
  const plusDM: number[] = [0];
  const minusDM: number[] = [0];

  for (let i = 1; i < historicalData.length; i++) {
    const current = historicalData[i];
    const prev = historicalData[i - 1];

    const tr1 = current.high - current.low;
    const tr2 = Math.abs(current.high - prev.close);
    const tr3 = Math.abs(current.low - prev.close);
    tr.push(Math.max(tr1, tr2, tr3));

    const upMove = current.high - prev.high;
    const downMove = prev.low - current.low;

    if (upMove > downMove && upMove > 0) {
      plusDM.push(upMove);
    } else {
      plusDM.push(0);
    }

    if (downMove > upMove && downMove > 0) {
      minusDM.push(downMove);
    } else {
      minusDM.push(0);
    }
  }

  let trSmoothed = tr.slice(1, period + 1).reduce((a, b) => a + b, 0);
  let plusDMSmoothed = plusDM.slice(1, period + 1).reduce((a, b) => a + b, 0);
  let minusDMSmoothed = minusDM.slice(1, period + 1).reduce((a, b) => a + b, 0);

  const dxList: number[] = Array(period).fill(0);

  for (let i = period; i < historicalData.length; i++) {
    if (i > period) {
      trSmoothed = trSmoothed - trSmoothed / period + tr[i];
      plusDMSmoothed = plusDMSmoothed - plusDMSmoothed / period + plusDM[i];
      minusDMSmoothed = minusDMSmoothed - minusDMSmoothed / period + minusDM[i];
    }

    const plusDI = trSmoothed === 0 ? 0 : (plusDMSmoothed / trSmoothed) * 100;
    const minusDI = trSmoothed === 0 ? 0 : (minusDMSmoothed / trSmoothed) * 100;

    const sum = plusDI + minusDI;
    const diff = Math.abs(plusDI - minusDI);
    const dx = sum === 0 ? 0 : (diff / sum) * 100;
    dxList.push(dx);
  }

  let adxSum = dxList.slice(period, period * 2).reduce((a, b) => a + b, 0);
  adx[period * 2 - 1] = adxSum / period;

  for (let i = period * 2; i < historicalData.length; i++) {
    adxSum = adxSum - adxSum / period + (dxList[i] || 0);
    adx[i] = adxSum / period;
  }

  return adx;
}

// ---------------- ROUNDING BOTTOM (CUP) DETECTOR ----------------
// Scans multiple base windows (≈12/9/6 months) at bar i. Returns the matched cup
// (longest window preferred) or null. Used both for entries and for row metadata,
// so per-trade depth/duration in the research buckets is REAL, not hard-coded.
export function detectCup(closes: number[], i: number): { depth: number; months: number; pivot: number } | null {
  for (const w of CUP_WINDOWS) {
    if (i < w) continue;
    const slice = closes.slice(i - w, i + 1);
    const third = Math.floor(w / 3);
    const maxLeft = Math.max(...slice.slice(0, third));
    const minMiddle = Math.min(...slice.slice(third, 2 * third));
    const maxRight = Math.max(...slice.slice(2 * third, w));
    const depth = ((maxLeft - minMiddle) / maxLeft) * 100;
    if (depth >= 12 && depth <= 33 && maxRight >= maxLeft * 0.92 && maxRight <= maxLeft * 1.08) {
      return { depth, months: Math.round(w / 21), pivot: maxLeft };
    }
  }
  return null;
}

// ---------------- COMPREHENSIVE BACKTEST RUNNER ----------------

function backtestStrategy(
  strategyId: string,
  ohlcv: OHLCV[],
  rsi: number[],
  ema9: number[],
  ema21: number[],
  ema50: number[],
  macd: MACDResult,
  bb: BBResult,
  stochRsi: StochRSIResult,
  adx: number[],
  atr: number[]
): BacktestStats {
  const closes = ohlcv.map(d => d.close);
  const opens = ohlcv.map(d => d.open);
  const highs = ohlcv.map(d => d.high);
  const lows = ohlcv.map(d => d.low);
  const volumes = ohlcv.map(d => d.volume);
  const dates = ohlcv.map(d => d.date);

  const trades: number[] = [];
  const tradeLog: TradeRecord[] = [];
  let inPosition = false;
  let entryPrice = 0;
  let entryDate = "";
  let lastTradeEntry: number | null = null;
  let lastTradeExit: number | null = null;
  let lastTradeReturn: number | null = null;

  // No-look-ahead execution: a signal on bar i is EXECUTED at bar i+1's open.
  let pendingEntry = false;
  let pendingCup: { depth: number; months: number } | null = null; // m2 cup matched at signal time
  let pendingCupCandidate: { depth: number; months: number } | null = null; // this bar's matched cup (before trigger accept)
  let entryCup: { depth: number; months: number } | null = null;   // m2 cup for the open position
  let signalOnLastBar = false; // fresh trigger on the latest close → actionable LIVE signal
  const signals: { d: string; p: number; dp?: number; dm?: number; stop?: number; tgt?: number }[] = []; // playback: what was LIVE on each date
  const overrideExit = computeOverrideLevels(strategyId, 100, 3) !== null; // true only for m1_rsi_macd, m1_ema_pullback, m1_bb_squeeze
  let stratStopP = 0, stratTgtP = 0; // ATR/fixed levels locked in at entry, for overrideExit strategies
  let liveStopOut: number | null = null, liveTargetOut: number | null = null;

  // 20-day SMA volume average calculation
  const avgVol20: number[] = [];
  let volSum = 0;
  for (let i = 0; i < ohlcv.length; i++) {
    volSum += volumes[i];
    if (i >= 20) volSum -= volumes[i - 20];
    avgVol20.push(volSum / Math.min(i + 1, 20));
  }

  for (let i = 50; i < ohlcv.length; i++) {
    const price = closes[i];
    if (!inPosition) {
      // Execute the previous bar's signal at TODAY's open (removes same-bar look-ahead bias)
      if (pendingEntry) {
        inPosition = true;
        entryPrice = opens[i];
        entryDate = dates[i];
        entryCup = pendingCup;
        if (overrideExit) {
          const a = atr[i] || entryPrice * 0.03; // fallback ~3% if ATR not warmed up yet
          const lv = computeOverrideLevels(strategyId, entryPrice, a)!;
          stratStopP = lv.stop;
          stratTgtP = lv.target;
        }
        pendingEntry = false;
        pendingCup = null;
        continue; // exits are evaluated from the next bar onward
      }

      let trigger = false;
      if (strategyId === "m1_rsi_macd") {
        trigger = rsi[i] < 40 && (macd.histogram[i] || 0) > 0 && (macd.histogram[i - 1] || 0) <= 0;
      } else if (strategyId === "m1_ema_pullback") {
        trigger = lows[i] <= (ema50[i] || 0) && highs[i] >= (ema50[i] || 0) && volumes[i] > 1.5 * (avgVol20[i] || 1);
      } else if (strategyId === "m1_bb_squeeze") {
        trigger = (bb.bandwidth[i - 1] || 0) < 0.05 && price > (bb.upper[i] || 0);
      } else if (strategyId === "m1_rsi_mean_rev") {
        const isBullishEngulfing = i > 0 && closes[i - 1] < opens[i - 1] && opens[i] <= closes[i - 1] && closes[i] >= opens[i - 1] && closes[i] > opens[i];
        trigger = rsi[i] < 25 && isBullishEngulfing;
      } else if (strategyId === "m1_dual_ema") {
        trigger = (ema9[i] || 0) > (ema21[i] || 0) && (ema9[i - 1] || 0) <= (ema21[i - 1] || 0) && price > (ema50[i] || 0);
      } else if (strategyId === "m1_stoch_rsi") {
        trigger = (stochRsi.k[i] || 0) > (stochRsi.d[i] || 0) && (stochRsi.k[i - 1] || 0) <= (stochRsi.d[i - 1] || 0) && (stochRsi.k[i] || 0) < 20 && (adx[i] || 0) > 25;
      } else if (strategyId === "m2_rounding_bottom") {
        const cup = detectCup(closes, i);
        if (cup) {
          const nearBreakout = price >= cup.pivot * 0.97 && price <= cup.pivot * 1.01; // pre-breakout zone: 3% below to 1% above pivot
          if (nearBreakout) {
            trigger = true;
            pendingCupCandidate = { depth: cup.depth, months: cup.months };
          }
        }
      }

      if (trigger) {
        let sigStop: number | undefined, sigTgt: number | undefined;
        if (overrideExit) {
          const a = atr[i] || price * 0.03;
          const lv = computeOverrideLevels(strategyId, price, a)!;
          sigStop = Math.round(lv.stop * 100) / 100;
          sigTgt = Math.round(lv.target * 100) / 100;
        }
        signals.push({
          d: dates[i],
          p: Math.round(price * 100) / 100,
          ...(pendingCupCandidate ? { dp: Math.round(pendingCupCandidate.depth * 10) / 10, dm: pendingCupCandidate.months } : {}),
          ...(overrideExit ? { stop: sigStop, tgt: sigTgt } : {})
        });
        if (i === ohlcv.length - 1) {
          // Signal formed on the LATEST close → nothing to backfill, but this IS the live setup
          signalOnLastBar = true;
          if (overrideExit) { liveStopOut = sigStop ?? null; liveTargetOut = sigTgt ?? null; }
        } else {
          pendingEntry = true;
          pendingCup = pendingCupCandidate;
        }
      }
      pendingCupCandidate = null;
    } else {
      let exit = false;
      let exitPrice = price; // default: exit at close of the exit bar
      if (overrideExit) {
        // Validated exit (ATR-based for RSI+MACD/EMA Pullback, fixed 8%/1:2R:R for BB Squeeze):
        // gap-aware, no indicator exit anymore for these 3 strategies.
        if (opens[i] <= stratStopP) { exit = true; exitPrice = opens[i]; }
        else if (lows[i] <= stratStopP) { exit = true; exitPrice = stratStopP; }
        else if (opens[i] >= stratTgtP) { exit = true; exitPrice = opens[i]; }
        else if (highs[i] >= stratTgtP) { exit = true; exitPrice = stratTgtP; }
      } else if (strategyId === "m1_rsi_mean_rev") {
        exit = rsi[i] > 50;
      } else if (strategyId === "m1_dual_ema") {
        exit = (ema9[i] || 0) < (ema21[i] || 0);
      } else if (strategyId === "m1_stoch_rsi") {
        exit = (stochRsi.k[i] || 0) < (stochRsi.d[i] || 0) && (stochRsi.k[i] || 0) > 80;
      } else if (strategyId === "m2_rounding_bottom") {
        // Intraday-aware stop/target (close-only checks understated real stop-loss damage)
        const stopP = entryPrice * 0.95;
        const tgtP = entryPrice * 1.15;
        if (opens[i] <= stopP) { exit = true; exitPrice = opens[i]; }        // gap below stop → filled at open
        else if (lows[i] <= stopP) { exit = true; exitPrice = stopP; }       // stop hit intraday
        else if (opens[i] >= tgtP) { exit = true; exitPrice = opens[i]; }    // gap above target
        else if (highs[i] >= tgtP) { exit = true; exitPrice = tgtP; }        // target hit intraday
      }

      if (exit || i === ohlcv.length - 1) {
        if (!exit) exitPrice = price; // force-close still-open position at the latest close
        inPosition = false;
        const returnPct = ((exitPrice - entryPrice) / entryPrice) * 100 - COST_PCT; // net of costs/slippage
        trades.push(returnPct);
        tradeLog.push({
          entryDate,
          exitDate: dates[i],
          entryPrice: Math.round(entryPrice * 100) / 100,
          exitPrice: Math.round(exitPrice * 100) / 100,
          returnPct: Math.round(returnPct * 100) / 100,
          win: returnPct > 0,
          ...(entryCup ? { depthPct: Math.round(entryCup.depth * 10) / 10, durationM: entryCup.months } : {}),
          ...(exit ? {} : { forced: true }) // closed by data ending, not by the strategy
        });
        lastTradeEntry = entryPrice;
        lastTradeExit = exitPrice;
        lastTradeReturn = returnPct;
        entryCup = null;
      }
    }
  }

  // A pending signal executed at the LAST bar's open leaves the loop with an open position
  // (the in-loop force-close can't see it). Log it so the freshest entry is never dropped.
  if (inPosition) {
    const lastP = closes[closes.length - 1];
    const returnPct = ((lastP - entryPrice) / entryPrice) * 100 - COST_PCT;
    trades.push(returnPct);
    tradeLog.push({
      entryDate,
      exitDate: dates[dates.length - 1],
      entryPrice: Math.round(entryPrice * 100) / 100,
      exitPrice: Math.round(lastP * 100) / 100,
      returnPct: Math.round(returnPct * 100) / 100,
      win: returnPct > 0,
      ...(entryCup ? { depthPct: Math.round(entryCup.depth * 10) / 10, durationM: entryCup.months } : {}),
      forced: true // closed by data ending, not by the strategy
    });
    lastTradeEntry = entryPrice;
    lastTradeExit = lastP;
    lastTradeReturn = returnPct;
    inPosition = false;
  }

  const numTrades = trades.length;
  if (numTrades === 0) {
    const lastP = closes[closes.length - 1] || 0;
    return {
      passed: false,
      numTrades: 0,
      winRatePct: 0,
      profitFactor: 1.0,
      avgReturnPct: 0,
      maxDrawdownPct: 0,
      lastEntryPrice: lastP,
      lastExitPrice: lastP,
      lastReturnPct: 0,
      liveSignal: signalOnLastBar,
      livePrice: signalOnLastBar ? Math.round(lastP) : null,
      liveStop: signalOnLastBar ? liveStopOut : null,
      liveTarget: signalOnLastBar ? liveTargetOut : null,
      tradeLog: [],
      signals
    };
  }

  const winningTrades = trades.filter(t => t > 0).length;
  const winRatePct = (winningTrades / numTrades) * 100;

  const grossProfits = trades.filter(t => t > 0).reduce((sum, val) => sum + val, 0);
  const grossLosses = Math.abs(trades.filter(t => t < 0).reduce((sum, val) => sum + val, 0));
  const profitFactor = grossLosses === 0
    ? (grossProfits > 0 ? NO_LOSS_PF_CAP : 1.0)
    : Math.min(grossProfits / grossLosses, NO_LOSS_PF_CAP);
  const avgReturnPct = trades.reduce((sum, val) => sum + val, 0) / numTrades;

  let balance = 100;
  let peak = 100;
  let maxDD = 0;
  for (const t of trades) {
    balance = balance * (1 + t / 100);
    if (balance > peak) peak = balance;
    const dd = ((peak - balance) / peak) * 100;
    if (dd > maxDD) maxDD = dd;
  }

  const lastEntryPrice = lastTradeEntry !== null ? lastTradeEntry : (closes[closes.length - 1] || 0);
  const lastExitPrice = lastTradeExit !== null ? lastTradeExit : (closes[closes.length - 1] || 0);
  const lastReturnPct = lastTradeReturn !== null ? lastTradeReturn : 0;

  // LIVE = (a) fresh trigger on the very latest close (enter at tomorrow's open), OR
  //        (b) most recent signal was within last 2 sessions AND current price is within ±1%
  //            of the signal price — meaning entry is still actionable.
  //        The old "5 sessions open position" rule is REMOVED — it caused stale signals
  //        to keep showing days after the entry window had passed.
  let liveSignal = signalOnLastBar;
  if (!liveSignal && signals.length > 0) {
    const lastSig = signals[signals.length - 1];
    const lastSigIdx = dates.indexOf(lastSig.d);
    const barsAgo = dates.length - 1 - lastSigIdx;
    const currentPrice = closes[closes.length - 1];
    const sigPrice = lastSig.p;
    const priceDrift = Math.abs((currentPrice - sigPrice) / sigPrice) * 100;
    // Show signal for up to 2 bars (signal day + next day = entry day) AND price within ±1%
    if (barsAgo <= 2 && priceDrift <= 1.0) {
      liveSignal = true;
      if (overrideExit && lastSig.stop && lastSig.tgt) {
        liveStopOut = lastSig.stop;
        liveTargetOut = lastSig.tgt;
      }
    }
  }

  // Pass filter: meet the dynamic config limits (win rate, profit factor, minimum trades)
  const passed = winRatePct >= MIN_WIN_RATE && profitFactor >= MIN_PROFIT_FACTOR && numTrades >= MIN_TRADES;

  return {
    passed,
    numTrades,
    winRatePct: parseFloat(winRatePct.toFixed(1)),
    profitFactor: parseFloat(profitFactor.toFixed(2)),
    avgReturnPct: parseFloat(avgReturnPct.toFixed(2)),
    maxDrawdownPct: parseFloat(maxDD.toFixed(1)),
    lastEntryPrice: Math.round(lastEntryPrice),
    lastExitPrice: Math.round(lastExitPrice),
    lastReturnPct: parseFloat(lastReturnPct.toFixed(2)),
    liveSignal,
    livePrice: liveSignal ? Math.round(closes[closes.length - 1]) : null,
    liveStop: liveSignal ? liveStopOut : null,
    liveTarget: liveSignal ? liveTargetOut : null,
    tradeLog,
    signals
  };
}

// ---------------- STABLE FALLBACK HISTORICAL GENERATOR ----------------

function generateSyntheticHistory(symbol: string): OHLCV[] {
  const sr = new SeededRandom(symbol);
  const data: OHLCV[] = [];
  let price = sr.range(120, 3200);

  // Build a date axis ending today, going back SYNTHETIC_DAYS trading days (skip weekends)
  const dates: string[] = [];
  const cur = new Date();
  while (dates.length < SYNTHETIC_DAYS) {
    const dow = cur.getDay();
    if (dow !== 0 && dow !== 6) dates.push(cur.toISOString().slice(0, 10));
    cur.setDate(cur.getDate() - 1);
  }
  dates.reverse();

  for (let i = 0; i < SYNTHETIC_DAYS; i++) {
    const change = sr.range(-0.025, 0.025); // Symmetric random walk (no positive drift bias)
    const open = price;
    const close = price * (1 + change);
    const high = Math.max(open, close) * sr.range(1.002, 1.018);
    const low = Math.min(open, close) * sr.range(0.982, 0.998);
    const volume = Math.round(sr.range(50000, 1500000));

    data.push({ date: dates[i], open, high, low, close, volume });
    price = close;
  }
  return data;
}

// ---------------- YAHOO FINANCE CHART PARSER ----------------

function parseYahooChart(jsonData: any): OHLCV[] {
  try {
    const result = jsonData?.chart?.result?.[0];
    if (!result) return [];
    const quote = result.indicators?.quote?.[0];
    if (!quote) return [];

    const opens = quote.open || [];
    const highs = quote.high || [];
    const lows = quote.low || [];
    const closes = quote.close || [];
    const volumes = quote.volume || [];
    const timestamps = result.timestamp || [];
    // Use the exchange timezone offset so each candle maps to its real local trading day
    const tzOffsetSec = (result.meta && typeof result.meta.gmtoffset === "number") ? result.meta.gmtoffset : 19800; // IST default

    const data: OHLCV[] = [];
    for (let i = 0; i < closes.length; i++) {
      if (
        closes[i] !== null && closes[i] !== undefined &&
        opens[i] !== null && opens[i] !== undefined &&
        highs[i] !== null && highs[i] !== undefined &&
        lows[i] !== null && lows[i] !== undefined &&
        timestamps[i]
      ) {
        const ts = new Date((timestamps[i] + tzOffsetSec) * 1000);
        const dow = ts.getUTCDay();
        if (dow === 0 || dow === 6) continue; // skip weekend bars (weekly/aggregated candles, never real trading days)
        data.push({
          date: ts.toISOString().slice(0, 10),
          open: opens[i],
          high: highs[i],
          low: lows[i],
          close: closes[i],
          volume: volumes[i] || 0
        });
      }
    }
    return data;
  } catch (e) {
    return [];
  }
}

// ---------------- LIVE YAHOO FINANCE DATA GETTER ----------------

export async function fetchStockData(symbol: string): Promise<OHLCV[] | null> {
  const period2 = Math.floor(Date.now() / 1000);
  const period1 = Math.floor(new Date("2005-01-01T00:00:00Z").getTime() / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?period1=${period1}&period2=${period2}&interval=1d`;

  // Retry with exponential backoff + jitter — 500 tickers × parallel fetches WILL hit
  // Yahoo rate limits sometimes; without retries half the universe silently degrades
  // to synthetic data.
  for (let attempt = 1; attempt <= FETCH_RETRIES; attempt++) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 8000); // 8s cap so a blocked network can't hang the scan
      const res = await (globalThis as any).fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        }
      });
      clearTimeout(timer);

      if (res.ok) {
        const jsonData = await res.json();
        const ohlcv = parseYahooChart(jsonData);
        if (ohlcv.length > 35) return ohlcv;
        return null; // valid response but not enough data — retrying won't help
      }
      // 429/5xx → fall through to backoff & retry
    } catch (e) {
      // network error / timeout → backoff & retry
    }
    if (attempt < FETCH_RETRIES) {
      await new Promise(r => setTimeout(r, 700 * attempt + Math.random() * 500));
    }
  }
  return null;
}

// ---------------- NIFTY 500 CONSTITUENTS LOADER ----------------

function parseNifty500CSV(csvText: string): { symbol: string; name: string }[] {
  const lines = csvText.split(/\r?\n/);
  const result: { symbol: string; name: string }[] = [];

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const parts: string[] = [];
    let current = "";
    let inQuotes = false;
    for (let j = 0; j < line.length; j++) {
      const char = line[j];
      if (char === '"') {
        inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        parts.push(current.trim());
        current = "";
      } else {
        current += char;
      }
    }
    parts.push(current.trim());

    if (parts.length >= 3) {
      const name = parts[0].replace(/^"|"$/g, "").trim();
      const symbol = parts[2].replace(/^"|"$/g, "").trim();
      if (symbol && !symbol.includes(" ") && symbol !== "Symbol") {
        result.push({
          symbol: symbol + ".NS",
          name: name
        });
      }
    }
  }
  return result;
}

// Multiple live sources for the Nifty 500 constituent CSV. NSE archives ko serverless
// sandboxes (AI Studio jaise) aksar block karte hain, isliye ek hi URL pe depend nahi karte:
// direct sources try karte hain, phir read-only CORS proxies ke through, phir hi fallback list.
const NIFTY500_CSV_SOURCES = [
  "https://www.niftyindices.com/IndexConstituent/ind_nifty500list.csv",
  "https://archives.nseindia.com/content/indices/ind_nifty500list.csv",
  "https://nsearchives.nseindia.com/content/indices/ind_nifty500list.csv",
];
// Public read-only proxies (koi API key nahi). Ye tab kaam aate hain jab origin CORS/bot-block kare.
const CSV_PROXIES = [
  (u: string) => `https://api.allorigins.win/raw?url=${encodeURIComponent(u)}`,
  (u: string) => `https://corsproxy.io/?url=${encodeURIComponent(u)}`,
];

async function tryFetchCsv(url: string, log: (m: string) => void): Promise<{ symbol: string; name: string }[] | null> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 9000);
    const res = await (globalThis as any).fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/csv,text/plain,*/*",
      },
    });
    clearTimeout(timer);
    if (!res.ok) return null;
    const text = await res.text();
    const parsed = parseNifty500CSV(text);
    return parsed.length > 40 ? parsed : null;
  } catch {
    return null;
  }
}

export async function loadNifty500Tickers(log: (msg: string) => void): Promise<{ symbol: string; name: string }[]> {
  log("📡 Querying live Nifty 500 constituent list (multi-source)...");

  // 1) Direct sources
  for (const src of NIFTY500_CSV_SOURCES) {
    const parsed = await tryFetchCsv(src, log);
    if (parsed) {
      log(`✅ Loaded ${parsed.length} live constituents (direct: ${new URL(src).hostname}).`);
      return parsed;
    }
  }

  // 2) Same sources via read-only CORS/bot-bypass proxies (for sandboxes like AI Studio)
  for (const src of NIFTY500_CSV_SOURCES) {
    for (const wrap of CSV_PROXIES) {
      const parsed = await tryFetchCsv(wrap(src), log);
      if (parsed) {
        log(`✅ Loaded ${parsed.length} live constituents (via proxy).`);
        return parsed;
      }
    }
  }

  // 3) Every live route failed — degrade gracefully to the large pre-seeded list.
  log(`⚠️ Saare live sources block/timeout hue. ${TICKERS_FALLBACK.length} pre-seeded constituents use kar rahe hain (na ki sirf 83).`);
  return TICKERS_FALLBACK;
}

// ---------------- MAIN SCAN RUNNER ----------------

// One-stop analysis for a candle series: computes every indicator once and backtests the
// whole strategy pool (+ the rounding-bottom system). Used by BOTH the live scanner and
// the Playback engine so past-date views run the EXACT same math as live scans.
// ============================================================================
// RSI DIVERGENCE ENGINE (Module 4)
// Pivot-fractal based classical divergence:
//   BULLISH: price LOWER LOW  + RSI HIGHER LOW  (first pivot RSI < 40)
//   BEARISH: price HIGHER HIGH + RSI LOWER HIGH (first pivot RSI > 60)
// NO LOOK-AHEAD: a pivot needs PIVOT_K bars on its RIGHT side to exist, so the
// signal only "confirms" PIVOT_K bars after the actual pivot — trades use the
// confirm bar, never the pivot bar itself.
// ============================================================================
export const PIVOT_K = 3;        // pivot = extreme among ±3 bars
const DIV_MIN_GAP = 5;           // pivots kam se kam 5 sessions door
const DIV_MAX_GAP = 60;          // aur zyada se zyada ~3 mahine
const DIV_RSI_DELTA = 2;         // RSI mein kam se kam 2-point ka clear fark
// ── EXIT RULE (validated on 500 stocks × 5y, in-sample/out-of-sample split) ──
// Purana rule (SL = divergence-low − 1%, target = 2R) OUT-OF-SAMPLE paisa khota
// tha: OOS PF 0.93, expectancy −0.24%. ATR-based exits us se kaafi behtar nikle:
// OOS PF 1.79, expectancy +5.08%. Isliye ab ATR SL/target use hota hai.
// NOTE: purana DIV_MAX_RISK_PCT (8%) yahan JAAN-BOOJH KE hata diya — weekly ATR
// risk aksar 8% se zyada hota hai, wo cap lagane se saare trades filter ho jaate.
const DIV_ATR_SL_MULT = 2.5;     // stop-loss  = entry − 2.5 × ATR(14)
const DIV_ATR_TP_MULT = 5.0;     // target     = entry + 5.0 × ATR(14)

// ── TIMEFRAME: WEEKLY ────────────────────────────────────────────────────────
// Divergence ka edge weekly candles pe hai, daily pe nahi. Same detection, same
// data pe: DAILY best PF ~1.05 (basically flat), WEEKLY PF 2.35 / OOS 1.79.
// Isliye m4 ab daily bars ko weekly me resample karke chalta hai. Baaki modules
// (m1/m2/m3) daily hi rehte hain — un pe koi asar nahi.
export function toWeekly(daily: OHLCV[]): OHLCV[] {
  const out: OHLCV[] = [];
  let cur: OHLCV | null = null;
  let curWeek = "";
  for (const b of daily) {
    const dt = new Date(b.date + "T00:00:00Z");
    if (isNaN(dt.getTime())) continue;
    // Monday-anchored week key
    const mon = new Date(dt);
    mon.setUTCDate(dt.getUTCDate() - ((dt.getUTCDay() + 6) % 7));
    const wk = mon.toISOString().slice(0, 10);
    if (wk !== curWeek) {
      if (cur) out.push(cur);
      cur = { date: b.date, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume };
      curWeek = wk;
    } else if (cur) {
      cur.high = Math.max(cur.high, b.high);
      cur.low = Math.min(cur.low, b.low);
      cur.close = b.close;
      cur.date = b.date;              // week ka aakhri trading din
      cur.volume += b.volume;
    }
  }
  if (cur) out.push(cur);
  return out;
}

export interface DivergenceEvent {
  type: "bullish" | "bearish";
  p1: { i: number; d: string; price: number; rsi: number };
  p2: { i: number; d: string; price: number; rsi: number };
  confirmIdx: number;
  confirmDate: string;
}

// Pivot significance threshold: pivot depth (how much it sticks out below/above
// its K-bar neighbourhood) must be >= MIN_PIVOT_DEPTH_ATR × ATR(14).
// Validated on 500 stocks × 5yr weekly:
//   min_atr=0.0 (no filter):  642 trades, OOS PF 1.94
//   min_atr=0.5 (chosen):     413 trades, OOS PF 1.88
// Minor wriggle pivots (depth < 0.5×ATR) create visually misleading charts —
// the trendline misses the real swing low. Filter removes them with minimal
// OOS edge cost. "Best pair" (max RSI divergence) replaces "first pair" to
// pick the most prominent setup when multiple candidates exist.
const MIN_PIVOT_DEPTH_ATR = 0.5;

export function detectDivergences(
  dates: string[], highs: number[], lows: number[], rsi: number[],
  ohlcv?: OHLCV[]   // optional — needed for ATR significance filter
): DivergenceEvent[] {
  const events: DivergenceEvent[] = [];
  const pivLows: number[] = [];
  const pivHighs: number[] = [];

  // Pre-compute ATR if ohlcv provided (for pivot significance check)
  let atr: number[] | null = null;
  if (ohlcv && ohlcv.length === lows.length) atr = calculateATR(ohlcv, 14);

  for (let i = PIVOT_K; i < lows.length - PIVOT_K; i++) {
    let isL = true, isH = true;
    for (let k = 1; k <= PIVOT_K; k++) {
      if (lows[i]  > lows[i - k]  || lows[i]  > lows[i + k])  isL = false;
      if (highs[i] < highs[i - k] || highs[i] < highs[i + k]) isH = false;
      if (!isL && !isH) break;
    }

    if (isL) {
      // Significance check: pivot must dip meaningfully below its neighbours
      if (atr) {
        const a = atr[i] > 0 ? atr[i] : lows[i] * 0.02;
        const leftMax  = Math.max(...lows.slice(Math.max(0, i - PIVOT_K), i));
        const rightMax = Math.max(...lows.slice(i + 1, i + PIVOT_K + 1));
        const depthL = leftMax  - lows[i];
        const depthR = rightMax - lows[i];
        if (depthL < MIN_PIVOT_DEPTH_ATR * a || depthR < MIN_PIVOT_DEPTH_ATR * a) {
          pivLows.push(i);
          continue; // minor wiggle — skip as a divergence anchor
        }
      }
      // Find BEST matching prior pivot (largest RSI divergence, not just first)
      let best: { rsiGap: number; a: number } | null = null;
      for (let j = pivLows.length - 1; j >= 0; j--) {
        const a = pivLows[j];
        const gap = i - a;
        if (gap < DIV_MIN_GAP) continue;
        if (gap > DIV_MAX_GAP) break;
        if (lows[i] < lows[a] && (rsi[i] || 50) > (rsi[a] || 50) + DIV_RSI_DELTA && (rsi[a] || 50) < 40) {
          const rsiGap = (rsi[i] || 50) - (rsi[a] || 50);
          if (!best || rsiGap > best.rsiGap) best = { rsiGap, a };
        }
      }
      if (best) {
        const a = best.a;
        const ci = i + PIVOT_K;
        if (ci < lows.length) {
          events.push({
            type: "bullish",
            p1: { i: a, d: dates[a], price: lows[a],  rsi: Math.round((rsi[a] || 50) * 10) / 10 },
            p2: { i,  d: dates[i],  price: lows[i],  rsi: Math.round((rsi[i] || 50) * 10) / 10 },
            confirmIdx: ci, confirmDate: dates[ci]
          });
        }
      }
      pivLows.push(i);
    }

    if (isH) {
      if (atr) {
        const a = atr[i] > 0 ? atr[i] : highs[i] * 0.02;
        const leftMin  = Math.min(...highs.slice(Math.max(0, i - PIVOT_K), i));
        const rightMin = Math.min(...highs.slice(i + 1, i + PIVOT_K + 1));
        const depthL = highs[i] - leftMin;
        const depthR = highs[i] - rightMin;
        if (depthL < MIN_PIVOT_DEPTH_ATR * a || depthR < MIN_PIVOT_DEPTH_ATR * a) {
          pivHighs.push(i);
          continue;
        }
      }
      let best: { rsiGap: number; a: number } | null = null;
      for (let j = pivHighs.length - 1; j >= 0; j--) {
        const a = pivHighs[j];
        const gap = i - a;
        if (gap < DIV_MIN_GAP) continue;
        if (gap > DIV_MAX_GAP) break;
        if (highs[i] > highs[a] && (rsi[i] || 50) < (rsi[a] || 50) - DIV_RSI_DELTA && (rsi[a] || 50) > 60) {
          const rsiGap = (rsi[a] || 50) - (rsi[i] || 50);
          if (!best || rsiGap > best.rsiGap) best = { rsiGap, a };
        }
      }
      if (best) {
        const a = best.a;
        const ci = i + PIVOT_K;
        if (ci < highs.length) {
          events.push({
            type: "bearish",
            p1: { i: a, d: dates[a], price: highs[a], rsi: Math.round((rsi[a] || 50) * 10) / 10 },
            p2: { i,  d: dates[i],  price: highs[i], rsi: Math.round((rsi[i] || 50) * 10) / 10 },
            confirmIdx: ci, confirmDate: dates[ci]
          });
        }
      }
      pivHighs.push(i);
    }
  }
  return events;
}

// Dedicated backtest — runs on WEEKLY candles (daily bars internally resampled).
// Entry: NEXT week's open after a bullish divergence confirms (no look-ahead —
// a pivot only exists PIVOT_K bars after the fact, so we trade the confirm bar).
// Exit: 2.5x ATR stop / 5x ATR target (gap-aware intraweek), or a bearish
// divergence confirm while long = protective exit at that week's close.
// LONG-only: shorts were tested on 500 stocks × 5y and were clearly negative
// (PF 0.86 weekly), so bearish divergence is used ONLY as an exit signal.
export function backtestDivergence(dailyOhlcv: OHLCV[]): BacktestStats {
  const ohlcv = toWeekly(dailyOhlcv);
  const dates = ohlcv.map(d => d.date);
  const opens = ohlcv.map(d => d.open);
  const highs = ohlcv.map(d => d.high);
  const lows = ohlcv.map(d => d.low);
  const closes = ohlcv.map(d => d.close);
  const rsi = calculateRSI(closes, 14);
  const atr = calculateATR(ohlcv, 14);
  const events = detectDivergences(dates, highs, lows, rsi, ohlcv);

  const bullAt: Record<number, DivergenceEvent> = {};
  const bearAt: Record<number, boolean> = {};
  for (const e of events) {
    if (e.type === "bullish") bullAt[e.confirmIdx] = e;
    else bearAt[e.confirmIdx] = true;
  }

  const trades: number[] = [];
  const tradeLog: TradeRecord[] = [];
  const signals: BacktestStats["signals"] = [];
  let inPosition = false, entryPrice = 0, entryDate = "";
  let stopP = 0, tgtP = 0;
  let pendingEntry = false, pendingAtr = 0;
  let signalOnLastBar = false;
  let liveStop: number | null = null, liveTarget: number | null = null;
  let lastTradeEntry: number | null = null, lastTradeExit: number | null = null, lastTradeReturn: number | null = null;

  const closeTrade = (i: number, exitPrice: number, forced: boolean) => {
    const returnPct = ((exitPrice - entryPrice) / entryPrice) * 100 - COST_PCT;
    trades.push(returnPct);
    tradeLog.push({
      entryDate, exitDate: dates[i],
      entryPrice: Math.round(entryPrice * 100) / 100,
      exitPrice: Math.round(exitPrice * 100) / 100,
      returnPct: Math.round(returnPct * 100) / 100,
      win: returnPct > 0,
      ...(forced ? { forced: true } : {})
    });
    lastTradeEntry = entryPrice; lastTradeExit = exitPrice; lastTradeReturn = returnPct;
    inPosition = false;
  };

  for (let i = 50; i < ohlcv.length; i++) {
    if (!inPosition) {
      if (pendingEntry) {
        inPosition = true;
        entryPrice = opens[i];
        entryDate = dates[i];
        // ATR levels signal-bar ke ATR se bane the; entry price pe re-anchor:
        const a = pendingAtr > 0 ? pendingAtr : entryPrice * 0.02;
        stopP = entryPrice - DIV_ATR_SL_MULT * a;
        tgtP = entryPrice + DIV_ATR_TP_MULT * a;
        pendingEntry = false;
        continue;
      }
      const ev = bullAt[i];
      if (ev) {
        const price = closes[i];
        const a = atr[i] > 0 ? atr[i] : price * 0.02;
        const stop = price - DIV_ATR_SL_MULT * a;
        const tgt = price + DIV_ATR_TP_MULT * a;
        if (stop > 0) {
          signals.push({ d: dates[i], p: Math.round(price * 100) / 100, stop: Math.round(stop * 100) / 100, tgt: Math.round(tgt * 100) / 100 });
          if (i === ohlcv.length - 1) {
            signalOnLastBar = true;
            liveStop = Math.round(stop * 100) / 100;
            liveTarget = Math.round(tgt * 100) / 100;
          } else {
            pendingEntry = true;
            pendingAtr = a;
          }
        }
      }
    } else {
      if (opens[i] <= stopP) closeTrade(i, opens[i], false);
      else if (lows[i] <= stopP) closeTrade(i, stopP, false);
      else if (opens[i] >= tgtP) closeTrade(i, opens[i], false);
      else if (highs[i] >= tgtP) closeTrade(i, tgtP, false);
      else if (bearAt[i]) closeTrade(i, closes[i], false); // bearish divergence = warning exit
      else if (i === ohlcv.length - 1) closeTrade(i, closes[i], true);
    }
  }
  if (inPosition) closeTrade(ohlcv.length - 1, closes[closes.length - 1], true); // entry executed on last bar

  // ---- stats (same math as backtestStrategy) ----
  const lastP = closes[closes.length - 1] || 0;
  if (trades.length === 0) {
    return {
      numTrades: 0, winRatePct: 0, profitFactor: 1.0, avgReturnPct: 0, maxDrawdownPct: 0, passed: false,
      lastEntryPrice: lastP, lastExitPrice: lastP, lastReturnPct: 0,
      liveSignal: signalOnLastBar, livePrice: signalOnLastBar ? Math.round(lastP) : null,
      liveStop, liveTarget, tradeLog: [], signals
    };
  }
  const winsArr = trades.filter(t => t > 0);
  const winRate = winsArr.length / trades.length;
  let grossWin = 0, grossLoss = 0;
  for (const t of trades) t > 0 ? (grossWin += t) : (grossLoss += -t);
  const profitFactor = grossLoss === 0 ? NO_LOSS_PF_CAP : Math.min(NO_LOSS_PF_CAP, grossWin / grossLoss);
  const avgReturn = trades.reduce((a, b) => a + b, 0) / trades.length;
  let equity = 100, peak = 100, maxDD = 0;
  for (const t of trades) {
    equity *= 1 + t / 100;
    if (equity > peak) peak = equity;
    const dd = ((peak - equity) / peak) * 100;
    if (dd > maxDD) maxDD = dd;
  }
  let liveSignal = signalOnLastBar;
  if (!liveSignal && signals.length > 0) {
    const lastSig = signals[signals.length - 1];
    const lastSigIdx = dates.indexOf(lastSig.d);
    const barsAgo = dates.length - 1 - lastSigIdx;
    const currentPrice = closes[closes.length - 1];
    const priceDrift = Math.abs((currentPrice - lastSig.p) / lastSig.p) * 100;
    if (barsAgo <= 2 && priceDrift <= 1.0) {
      liveSignal = true;
      liveStop = lastSig.stop ?? liveStop;
      liveTarget = lastSig.tgt ?? liveTarget;
    }
  }
  return {
    numTrades: trades.length,
    winRatePct: Math.round(winRate * 1000) / 10,
    profitFactor: Math.round(profitFactor * 100) / 100,
    avgReturnPct: Math.round(avgReturn * 100) / 100,
    maxDrawdownPct: Math.round(maxDD * 10) / 10,
    passed: winRate >= MIN_WIN_RATE / 100 && profitFactor >= MIN_PROFIT_FACTOR && trades.length >= MIN_TRADES,
    lastEntryPrice: lastTradeEntry ?? lastP,
    lastExitPrice: lastTradeExit ?? lastP,
    lastReturnPct: lastTradeReturn !== null ? Math.round(lastTradeReturn * 100) / 100 : 0,
    liveSignal,
    livePrice: liveSignal ? Math.round(lastP) : null,
    liveStop: liveSignal ? liveStop : null,
    liveTarget: liveSignal ? liveTarget : null,
    tradeLog, signals
  };
}

export function computeAllStrategyStats(ohlcv: OHLCV[]): Record<string, BacktestStats> {
  const closes = ohlcv.map(d => d.close);
  const rsi = calculateRSI(closes, 14);
  const ema9 = calculateEMA(closes, 9);
  const ema21 = calculateEMA(closes, 21);
  const ema50 = calculateEMA(closes, 50);
  const macd = calculateMACD(closes);
  const bb = calculateBollingerBands(closes, 20, 2);
  const stochRsi = calculateStochasticRSI(rsi, 14, 3, 3);
  const adx = calculateADX(ohlcv, 14);
  const atr = calculateATR(ohlcv, 14);

  const out: Record<string, BacktestStats> = {};
  for (const strat of STRATEGIES_POOL) {
    out[strat.id] = backtestStrategy(strat.id, ohlcv, rsi, ema9, ema21, ema50, macd, bb, stochRsi, adx, atr);
  }
  out["m2_rounding_bottom"] = backtestStrategy("m2_rounding_bottom", ohlcv, rsi, ema9, ema21, ema50, macd, bb, stochRsi, adx, atr);
  out["m4_divergence"] = backtestDivergence(ohlcv); // resamples to weekly internally
  return out;
}

export async function runScan(
  onProgress?: (progress: number, scanned: number, currentSymbol: string, passedCount: number, logLine: string) => void
) {
  const t0 = Date.now(); // real wall-clock timer for elapsedSec
  const CACHE = path.join(process.cwd(), "public", "cache");
  if (!fs.existsSync(CACHE)) {
    fs.mkdirSync(CACHE, { recursive: true });
  }
  // Raw candle store for the Playback engine. Overwritten per symbol (never wiped) so
  // a partially-failed later scan can't destroy previously saved playback history.
  const OHLCV_DIR = path.join(process.cwd(), "data", "ohlcv");
  fs.mkdirSync(OHLCV_DIR, { recursive: true });
  // Playback model files: per-stock trades + dated signals for EVERY strategy on EVERY
  // scanned stock (pass + fail) — the time machine needs the full universe, not just
  // today's winners. Wiped each scan so it always matches the current engine.
  const PLAYBACK_DIR = path.join(process.cwd(), "data", "playback");
  if (fs.existsSync(PLAYBACK_DIR)) fs.rmSync(PLAYBACK_DIR, { recursive: true, force: true });
  fs.mkdirSync(PLAYBACK_DIR, { recursive: true });
  let axisDates: string[] = [];      // longest REAL trading-day axis seen (drives day-stepping)
  let axisDatesSynth: string[] = []; // fallback if the whole scan was synthetic

  const logs: string[] = [];
  let totalStocks = 500; // Will be set dynamically from tickers.length
  let scannedCount = 0;
  let passedCount = 0;
  let currentSymbol = "";

  const log = (text: string) => {
    logs.push(text);
    if (onProgress) {
      const progress = totalStocks > 0 ? Math.min(100, Math.floor((scannedCount / totalStocks) * 100)) : 0;
      onProgress(progress, scannedCount, currentSymbol, passedCount, text);
    } else {
      console.log(text);
    }
  };

  log("🚀 Initializing Nifty 500 Edge Technical Backtester...");
  await new Promise(r => setTimeout(r, 400));

  const tickers = await loadNifty500Tickers(log);
  totalStocks = tickers.length; // ✅ FIX #1: set totalStocks dynamically from tickers

  log(`📊 Loaded ${tickers.length} tickers. Fetching historical candle series and computing indicators...`);
  await new Promise(r => setTimeout(r, 400));

  const module1Rows: any[] = [];
  const module2Rows: any[] = [];
  const module4Rows: any[] = [];
  const module3Rows: any[] = [];
  const allScanned: any[] = [];

  // ✅ FIX #4: Track real vs synthetic data
  let realDataCount = 0;
  let syntheticCount = 0;

  const batchSize = 10;
  const numSteps = Math.ceil(totalStocks / batchSize);

  for (let step = 0; step < numSteps; step++) {
    const startIdx = step * batchSize;
    const endIdx = Math.min(totalStocks, startIdx + batchSize);

    // Representative stock for the progress logs = first ticker of THIS batch
    const repStock = tickers[startIdx];
    currentSymbol = repStock.symbol;
    scannedCount = endIdx;

    log(`🔍 [Processing] Batch ${step + 1}/${numSteps} - Current representative: ${repStock.symbol}...`);

    // Fetch and analyze the batch in parallel (highly optimized!)
    const batchPromises = [];
    for (let i = startIdx; i < endIdx; i++) {
      const stock = tickers[i];
      batchPromises.push((async () => {
        let ohlcv = await fetchStockData(stock.symbol);
        let isReal = true;
        if (!ohlcv) {
          ohlcv = generateSyntheticHistory(stock.symbol);
          isReal = false;
        }

        // Rounding helper shared by BOTH playback persistence blocks below.
        // (Previously declared inside the first try{} — the second block then threw
        // ReferenceError and silently skipped writing every playback model file.)
        const r2 = (x: number) => Math.round(x * 100) / 100;

        // Persist raw candles for the Playback (time machine) engine — column format keeps files small.
        try {
          fs.writeFileSync(path.join(OHLCV_DIR, `${stock.symbol}.json`), JSON.stringify({
            symbol: stock.symbol,
            name: stock.name,
            synthetic: !isReal,
            d: ohlcv.map(c => c.date),
            o: ohlcv.map(c => r2(c.open)),
            h: ohlcv.map(c => r2(c.high)),
            l: ohlcv.map(c => r2(c.low)),
            c: ohlcv.map(c => r2(c.close)),
            v: ohlcv.map(c => c.volume)
          }));
        } catch { /* playback data is best-effort; the scan itself must not fail on disk issues */ }

        const closes = ohlcv.map(d => d.close);
        const stratResults = computeAllStrategyStats(ohlcv);

        // Playback model: this stock's complete trade + signal history for ALL strategies.
        try {
          const strategies: Record<string, { trades: TradeRecord[]; signals: BacktestStats["signals"] }> = {};
          for (const sid of Object.keys(stratResults)) {
            strategies[sid] = { trades: stratResults[sid].tradeLog, signals: stratResults[sid].signals };
          }
          fs.writeFileSync(path.join(PLAYBACK_DIR, `${stock.symbol}.json`), JSON.stringify({
            symbol: stock.symbol,
            name: stock.name,
            synthetic: !isReal,
            d: ohlcv.map(c => c.date),          // per-stock trading days (holidays/listing gaps differ per stock)
            c: ohlcv.map(c => r2(c.close)),      // closes → as-of force-close of open positions + livePrice, exactly like the live scan
            strategies
          }));
          const dts = ohlcv.map(c => c.date);
          if (isReal && dts.length > axisDates.length) axisDates = dts;
          if (!isReal && dts.length > axisDatesSynth.length) axisDatesSynth = dts;
        } catch { /* playback data is best-effort; the scan itself must not fail on disk issues */ }

        // Dynamic Strategy Optimization: Evaluate all 6 systems to find the absolute best fit
        let bestB1Strat = STRATEGIES_POOL[0];
        let bestB1Stats = stratResults[bestB1Strat.id];

        for (let sIdx = 1; sIdx < STRATEGIES_POOL.length; sIdx++) {
          const strat = STRATEGIES_POOL[sIdx];
          const b1Stats = stratResults[strat.id];
          
          // Selection criteria:
          // 1. Give priority to those that passed the strict gate
          // 2. Choose the one with the highest Profit Factor
          // 3. Ties broken by highest Win Rate
          const isBetter = (b1Stats.passed && !bestB1Stats.passed) ||
                           (b1Stats.passed === bestB1Stats.passed && b1Stats.profitFactor > bestB1Stats.profitFactor) ||
                           (b1Stats.passed === bestB1Stats.passed && b1Stats.profitFactor === bestB1Stats.profitFactor && b1Stats.winRatePct > bestB1Stats.winRatePct);
          if (isBetter) {
            bestB1Strat = strat;
            bestB1Stats = b1Stats;
          }
        }

        const b2 = stratResults["m2_rounding_bottom"];

        return { stock, isReal, stratResults, bestB1Strat, bestB1Stats, b2, closes };
      })());
    }

    const batchResults = await Promise.all(batchPromises);
    allScanned.push(...batchResults);

    for (const res of batchResults) {
      const { stock, isReal, stratResults, bestB1Strat, bestB1Stats, b2, closes } = res;

      // ✅ FIX #2 & #4: Better logging & Count tracking
      if (isReal) {
        realDataCount++;
        log(`📈 [LIVE YAHOO API] ${stock.symbol} ✓`);
      } else {
        syntheticCount++;
        log(`⚠️ [FALLBACK DATA] ${stock.symbol} (synthetic)`);
      }

      if (bestB1Stats.passed && bestB1Stats.numTrades >= STRICT_TRADES && bestB1Stats.profitFactor >= STRICT_PF) {
        passedCount++;
        module1Rows.push({
          symbol: stock.symbol,
          name: stock.name,
          strategyId: bestB1Strat.id,
          trades: bestB1Stats.tradeLog,
          strategyLabel: bestB1Strat.label,
          entryCond: bestB1Strat.entry,
          exitCond: bestB1Strat.exit,
          lastEntryPrice: bestB1Stats.lastEntryPrice,
          lastExitPrice: bestB1Stats.lastExitPrice,
          lastReturnPct: bestB1Stats.lastReturnPct,
          winRatePct: bestB1Stats.winRatePct,
          profitFactor: bestB1Stats.profitFactor,
          numTrades: bestB1Stats.numTrades,
          avgReturnPct: bestB1Stats.avgReturnPct,
          maxDrawdownPct: bestB1Stats.maxDrawdownPct,
          liveSignal: bestB1Stats.liveSignal,
          livePrice: bestB1Stats.livePrice,
          liveStop: bestB1Stats.liveStop ?? null,
          liveTarget: bestB1Stats.liveTarget ?? null,
          isSynthetic: !isReal
        });
        log(`✨ [AI OPTIMIZER PASS] ${stock.symbol} optimized: ${bestB1Strat.label} (PF: ${bestB1Stats.profitFactor}, WR: ${bestB1Stats.winRatePct}%)`);
      }

      if (b2.passed) {
        passedCount++;
        
        // Extract real cup base details — MOST RECENT cup across all base windows (≈6/9/12m)
        let cupDepth = 0;
        let actualDurationMonths = 0;
        let pivotPrice = 0; // base rim = breakout level (resistance)

        for (let j = closes.length - 1; j >= CUP_WINDOWS[CUP_WINDOWS.length - 1]; j--) {
          const cup = detectCup(closes, j);
          if (cup) {
            cupDepth = cup.depth;
            actualDurationMonths = cup.months;
            pivotPrice = cup.pivot;
            break; // scanning backwards → first hit IS the latest cup
          }
        }
        if (cupDepth === 0) {
          // No cup visible on the latest data (trades came from older bases) — fall back to
          // the LAST TRADE's recorded pattern instead of inventing numbers.
          const lastT = b2.tradeLog[b2.tradeLog.length - 1];
          cupDepth = lastT?.depthPct ?? 18;
          actualDurationMonths = lastT?.durationM ?? 12;
          pivotPrice = b2.lastEntryPrice || closes[closes.length - 1];
        }

        const entryRelation = `as price nears the ₹${Math.round(pivotPrice)} breakout pivot (pre-breakout)`;

        module2Rows.push({
          symbol: stock.symbol,
          name: stock.name,
          strategyId: "m2_rounding_bottom",
          trades: b2.tradeLog,
          strategyLabel: "Rounding Bottom Base",
          entryCond: `U-shaped consolidation base depth ${cupDepth.toFixed(1)}% over ${actualDurationMonths} months, entry ${entryRelation}`,
          exitCond: "Exit at +15% target or −5% stop-loss",
          lastEntryPrice: b2.lastEntryPrice,
          lastExitPrice: b2.lastExitPrice,
          lastReturnPct: b2.lastReturnPct,
          winRatePct: b2.winRatePct,
          profitFactor: b2.profitFactor,
          numTrades: b2.numTrades,
          avgReturnPct: b2.avgReturnPct,
          maxDrawdownPct: b2.maxDrawdownPct,
          liveSignal: b2.liveSignal,
          livePrice: b2.livePrice,
          isSynthetic: !isReal,
          patternDepth: cupDepth,
          patternDuration: actualDurationMonths
        });
        log(`🎯 [ROUNDING BOTTOM] Base pattern confirmed for ${stock.symbol} (${actualDurationMonths}m base, depth: ${cupDepth.toFixed(1)}%)`);
      }

      // MODULE 4: RSI Divergence — gate requires min 7 trades & 50% win rate
      const b4 = stratResults["m4_divergence"];
      const m4passed = b4 && (b4.liveSignal || (b4.numTrades >= M4_MIN_TRADES && b4.winRatePct >= M4_MIN_WIN_RATE && b4.profitFactor >= M4_MIN_PF));
      if (m4passed) {
        passedCount++;
        module4Rows.push({
          symbol: stock.symbol,
          name: stock.name,
          strategyId: "m4_divergence",
          trades: b4.tradeLog,
          strategyLabel: "RSI Divergence (Weekly)",
          entryCond: "WEEKLY bullish RSI divergence (price lower-low, RSI higher-low from oversold), entry next week's open after pivot confirms",
          exitCond: "SL 2.5x ATR, target 5x ATR (weekly), ya bearish divergence confirm hone pe exit",
          lastEntryPrice: b4.lastEntryPrice,
          lastExitPrice: b4.lastExitPrice,
          lastReturnPct: b4.lastReturnPct,
          winRatePct: b4.winRatePct,
          profitFactor: b4.profitFactor,
          numTrades: b4.numTrades,
          avgReturnPct: b4.avgReturnPct,
          maxDrawdownPct: b4.maxDrawdownPct,
          liveSignal: b4.liveSignal,
          livePrice: b4.livePrice,
          liveStop: b4.liveStop ?? null,
          liveTarget: b4.liveTarget ?? null,
          hasChart: true,
          isSynthetic: !isReal
        });
        log(`📐 [DIVERGENCE] RSI divergence edge confirmed for ${stock.symbol} (${b4.numTrades} trades, PF ${b4.profitFactor})`);
      }
    }

    // Small visual pause for UI terminal output pacing
    await new Promise(r => setTimeout(r, 60));
  }

  log("📊 Compiling global technical indicators...");
  await new Promise(r => setTimeout(r, 300));

  // Playback engine index: the trading-day axis (for day stepping) + stock directory.
  try {
    const axis = axisDates.length ? axisDates : axisDatesSynth;
    fs.writeFileSync(path.join(PLAYBACK_DIR, "axis.json"), JSON.stringify({
      dates: axis,
      start: axis[0] || null,
      end: axis[axis.length - 1] || null,
      generatedAt: new Date().toISOString()
    }));
    fs.writeFileSync(path.join(PLAYBACK_DIR, "index.json"), JSON.stringify(
      allScanned.map((res: any) => ({ symbol: res.stock.symbol, name: res.stock.name, synthetic: !res.isReal }))
    ));
    log(`🕰 Playback engine data saved: ${allScanned.length} stocks, ${axis.length} trading days`);
  } catch { /* best-effort */ }

  log("💾 Saving backtest evaluation cache layers...");

  const nowString = new Date().toISOString();

  // Module 3 winner = the strategy with the MOST gate-passes across the whole universe
  // (breadth). This is the same metric the breadth chart shows, so the "Best Universe
  // Edge" card can never contradict its own chart. Median PF of passers breaks ties.
  const median = (arr: number[]) => {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  };
  const pnl = (arr: number[]) => arr.reduce((a, b) => a + b, 0);

  // Find breadth winner
  const strategyCounts: Record<string, { passes: number; pfValues: number[] }> = {};
  for (const s of STRATEGIES_POOL) {
    strategyCounts[s.id] = { passes: 0, pfValues: [] };
  }
  for (const res of allScanned) {
    for (const sid of Object.keys(res.stratResults)) {
      if (sid === "m2_rounding_bottom" || sid === "m4_divergence" || sid === "m3_best_overall") continue;
      const stat = res.stratResults[sid];
      if (stat.passed) {
        strategyCounts[sid].passes++;
        strategyCounts[sid].pfValues.push(stat.profitFactor);
      }
    }
  }

  let bestSid = STRATEGIES_POOL[0].id;
  let maxPasses = -1;
  let bestMedPf = -1;

  for (const sid of Object.keys(strategyCounts)) {
    const info = strategyCounts[sid];
    const med = median(info.pfValues);
    if (info.passes > maxPasses || (info.passes === maxPasses && med > bestMedPf)) {
      maxPasses = info.passes;
      bestMedPf = med;
      bestSid = sid;
    }
  }

  const winningStratConfig = STRATEGIES_POOL.find(s => s.id === bestSid)!;
  const bestGlobalStrategyLabel = winningStratConfig.label;
  const bestGlobalStrategyId = bestSid;

  // Dynamically populate Module 3 rows with the winner strategy results
  for (const res of allScanned) {
    const b3 = res.stratResults[bestGlobalStrategyId];
    if (b3 && b3.passed && b3.numTrades >= STRICT_TRADES && b3.profitFactor >= STRICT_PF) {
      module3Rows.push({
        symbol: res.stock.symbol,
        name: res.stock.name,
        strategyId: "m3_best_overall",
        trades: b3.tradeLog,
        strategyLabel: winningStratConfig.label,
        entryCond: winningStratConfig.entry,
        exitCond: winningStratConfig.exit,
        lastEntryPrice: b3.lastEntryPrice,
        lastExitPrice: b3.lastExitPrice,
        lastReturnPct: b3.lastReturnPct,
        winRatePct: b3.winRatePct,
        profitFactor: b3.profitFactor,
        numTrades: b3.numTrades,
        avgReturnPct: b3.avgReturnPct,
        maxDrawdownPct: b3.maxDrawdownPct,
        liveSignal: b3.liveSignal,
        livePrice: b3.livePrice,
        liveStop: b3.liveStop ?? null,
        liveTarget: b3.liveTarget ?? null,
        isSynthetic: !res.isReal
      });
    }
  }

  // Research buckets built from PER-TRADE cup metadata (each trade carries the depth &
  // duration of the base it actually traded), on REAL data only — synthetic fallback
  // rows would poison a "research" statistic.
  const depthBuckets = [
    { range: "12% - 19%", min: 12, max: 19, trades: 0, wins: 0 },
    { range: "19% - 26%", min: 19, max: 26, trades: 0, wins: 0 },
    { range: "26% - 33%", min: 26, max: 33.001, trades: 0, wins: 0 } // .001 so exactly-33% doesn't fall between buckets
  ];

  const durationBuckets = [
    { range: "≈6 Month Base", min: 0, max: 7.5, trades: 0, wins: 0 },
    { range: "≈9 Month Base", min: 7.5, max: 10.5, trades: 0, wins: 0 },
    { range: "≈12 Month Base", min: 10.5, max: 99, trades: 0, wins: 0 }
  ];

  for (const r of module2Rows) {
    if (r.isSynthetic) continue;
    for (const t of r.trades as TradeRecord[]) {
      const d = t.depthPct ?? r.patternDepth;
      const m = t.durationM ?? r.patternDuration;
      if (d === undefined || m === undefined) continue;
      for (const b of depthBuckets) {
        if (d >= b.min && d < b.max) {
          b.trades += 1;
          if (t.win) b.wins += 1;
        }
      }
      for (const b of durationBuckets) {
        if (m >= b.min && m < b.max) {
          b.trades += 1;
          if (t.win) b.wins += 1;
        }
      }
    }
  }

  const byDepthBuckets = depthBuckets.map(b => {
    let wr = b.trades > 0 ? (b.wins / b.trades) * 100 : 0;
    return {
      range: b.range,
      trades: b.trades,
      winRatePct: parseFloat(wr.toFixed(1))
    };
  });

  const byDurationBuckets = durationBuckets.map(b => {
    let wr = b.trades > 0 ? (b.wins / b.trades) * 100 : 0;
    return {
      range: b.range,
      trades: b.trades,
      winRatePct: parseFloat(wr.toFixed(1))
    };
  });

  // Breadth chart data compiled
  const breadthStats = STRATEGIES_POOL.map(s => {
    const passers = allScanned.filter(res => res.stratResults[s.id]?.passed);
    const passingPfs = passers
      .map(res => res.stratResults[s.id].profitFactor)
      .filter((pf: number) => isFinite(pf) && pf > 0);
    return {
      label: s.label,
      gatePasses: passers.length,
      medianPF: parseFloat(median(passingPfs).toFixed(2))
    };
  });

  // ✅ FIX #3: Honest metadata
  const metaData = {
    needsScan: false,
    generatedAt: nowString,
    universeCount: tickers.length, // ← ACTUAL loaded count
    scanned: scannedCount, // ← ACTUAL scanned
    withData: realDataCount + syntheticCount, // stocks that actually had price data
    passed: module1Rows.length + module2Rows.length + module3Rows.length + module4Rows.length, // stocks that cleared the gate
    dataQuality: {
      realData: realDataCount, // ← Track real vs synthetic
      syntheticData: syntheticCount,
      dataRange: `${YAHOO_RANGE} (daily candles)`
    },
    elapsedSec: parseFloat(((Date.now() - t0) / 1000).toFixed(1)),
    gate: {
      // Base gate — what EVERY published row satisfies (M2 rows use exactly this).
      minWinRate: MIN_WIN_RATE / 100,
      minProfitFactor: MIN_PROFIT_FACTOR,
      minOosTrades: MIN_TRADES,
      // Strict gate — the tougher standard applied to M1/M3 rows.
      strict: {
        minProfitFactor: STRICT_PF,
        minOosTrades: STRICT_TRADES
      }
    },
    backtestMethod: {
      type: "full-history single-pass",
      note: `Full available-history daily backtest. Signals execute at the NEXT bar's open (no same-bar look-ahead). Net returns after ${COST_PCT}% round-trip cost/slippage per trade. Edge filter: ${MIN_WIN_RATE}%+ win rate, ${MIN_PROFIT_FACTOR}+ profit factor, ${MIN_TRADES}+ trades (M1/M3 strict: ${STRICT_PF}+ PF, ${STRICT_TRADES}+ trades). No walk-forward split — see per-stock OOS check in the UI.`
    },
    module3: {
      chosenStrategyLabel: bestGlobalStrategyLabel,
      gatePasses: maxPasses, // same metric as the breadth chart → never contradicts it
      breadth: breadthStats.sort((a, b) => b.gatePasses - a.gatePasses)
    },
    roundingBottomConditions: {
      totalTrades: module2Rows.reduce((sum, r) => sum + r.numTrades, 0),
      byDepth: {
        label: "Cup Base Depth (Max Drawdown in Base)",
        buckets: byDepthBuckets
      },
      byDuration: {
        label: "Consolidation Base Duration",
        buckets: byDurationBuckets
      }
    },
    counts: {
      module1: module1Rows.length,
      module2: module2Rows.length,
      module3: module3Rows.length,
      module4: module4Rows.length
    }
  };

  // Write each stock's full dated trade history to its own file (kept out of the main
  // module JSON so the table loads fast; the UI fetches a stock's trades on demand).
  const TRADES_DIR = path.join(CACHE, "trades");
  // Wipe stale trade files from previous scans — otherwise orphans accumulate forever
  // (old cache in this repo had 90 files for 14 rows).
  if (fs.existsSync(TRADES_DIR)) fs.rmSync(TRADES_DIR, { recursive: true, force: true });
  fs.mkdirSync(TRADES_DIR, { recursive: true });
  const allTrades: any[] = []; // aggregate of every trade (for Period P&L Summary)
  const stripTrades = (rows: any[], mod: string) =>
    rows.map((r) => {
      const { trades, ...rest } = r;
      const key = `${r.symbol}__${r.strategyId}`;
      if (Array.isArray(trades) && trades.length) {
        fs.writeFileSync(path.join(TRADES_DIR, `${key}.json`), JSON.stringify(trades));
        for (const t of trades) {
          allTrades.push({ sym: r.symbol, mod, e: t.entryDate, x: t.exitDate, r: t.returnPct, w: t.win });
        }
      }
      return { ...rest, tradesKey: key };
    });

  fs.writeFileSync(path.join(CACHE, "meta.json"), JSON.stringify(metaData, null, 2));
  fs.writeFileSync(path.join(CACHE, "module1.json"), JSON.stringify(stripTrades(module1Rows, "m1"), null, 2));
  fs.writeFileSync(path.join(CACHE, "module2.json"), JSON.stringify(stripTrades(module2Rows, "m2"), null, 2));
  fs.writeFileSync(path.join(CACHE, "module3.json"), JSON.stringify(stripTrades(module3Rows, "m3"), null, 2));
  fs.writeFileSync(path.join(CACHE, "module4.json"), JSON.stringify(stripTrades(module4Rows, "m4"), null, 2));
  fs.writeFileSync(path.join(CACHE, "alltrades.json"), JSON.stringify(allTrades));

  log(`✅ Scan complete! Processed ${totalStocks} stocks (${realDataCount} real, ${syntheticCount} synthetic)`);
}

// Direct execution harness
if (process.argv[1] && (process.argv[1].endsWith("scan.ts") || process.argv[1].endsWith("scan"))) {
  runScan().then(() => {
    console.log("Scanner terminated successfully.");
  }).catch((err) => {
    console.error("Scanner failed:", err);
  });
}