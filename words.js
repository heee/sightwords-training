// ===========================================================
// Sight Words Training — word lists
// Order matters: new words are introduced to a kid in list order
// (easiest / most frequent first), per language.
//
// CRITICAL: the original 220 EN / 210 DE words (see LEVELS below for the
// exact boundary) must never be reordered or edited — stored per-kid
// progress is keyed by these exact strings. Only ever APPEND new words
// after the existing ones.
// ===========================================================

const WORDS = {
  // The complete standard Dolch sight word list — 220 "service" words
  // (pre-primer through third grade) — followed by the standard 95 Dolch
  // nouns, appended as a separate reading-level band (see LEVELS.en).
  en: [
    // Pre-primer (40)
    "a", "and", "away", "big", "blue", "can", "come", "down", "find", "for",
    "funny", "go", "help", "here", "I", "in", "is", "it", "jump", "little",
    "look", "make", "me", "my", "not", "one", "play", "red", "run", "said",
    "see", "the", "three", "to", "two", "up", "we", "where", "yellow", "you",
    // Primer (52)
    "all", "am", "are", "at", "ate", "be", "black", "brown", "but", "came",
    "did", "do", "eat", "four", "get", "good", "have", "he", "into", "like",
    "must", "new", "no", "now", "on", "our", "out", "please", "pretty", "ran",
    "ride", "saw", "say", "she", "so", "soon", "that", "there", "they", "this",
    "too", "under", "want", "was", "well", "went", "what", "white", "who", "will",
    "with", "yes",
    // First grade (41)
    "after", "again", "an", "any", "as", "ask", "by", "could", "every", "fly",
    "from", "give", "going", "had", "has", "her", "him", "his", "how", "just",
    "know", "let", "live", "may", "of", "old", "once", "open", "over", "put",
    "round", "some", "stop", "take", "thank", "them", "then", "think", "walk", "were",
    "when",
    // Second grade (46)
    "always", "around", "because", "been", "before", "best", "both", "buy", "call", "cold",
    "does", "don't", "fast", "first", "five", "found", "gave", "goes", "green", "its",
    "made", "many", "off", "or", "pull", "read", "right", "sing", "sit", "sleep",
    "tell", "their", "these", "those", "upon", "us", "use", "very", "wash", "which",
    "why", "wish", "work", "would", "write", "your",
    // Third grade (41)
    "about", "better", "bring", "carry", "clean", "cut", "done", "draw", "drink", "eight",
    "fall", "far", "full", "got", "grow", "hold", "hot", "hurt", "if", "keep",
    "kind", "laugh", "light", "long", "much", "myself", "never", "only", "own", "pick",
    "seven", "shall", "show", "six", "small", "start", "ten", "today", "together", "try",
    "warm",
    // Standard Dolch nouns (95) — appended as their own tier beyond third
    // grade (see README's "Reading levels" section for how levels map here).
    "apple", "baby", "back", "ball", "bear", "bed", "bell", "bird", "birthday", "boat",
    "box", "boy", "bread", "brother", "cake", "car", "cat", "chair", "chicken", "children",
    "Christmas", "coat", "corn", "cow", "day", "dog", "doll", "door", "duck", "egg",
    "eye", "farm", "farmer", "father", "feet", "fire", "fish", "floor", "flower", "game",
    "garden", "girl", "goodbye", "grass", "ground", "hand", "head", "hill", "home", "horse",
    "house", "kitty", "leg", "letter", "man", "men", "milk", "money", "morning", "mother",
    "name", "nest", "night", "paper", "party", "picture", "pig", "rabbit", "rain", "ring",
    "robin", "Santa Claus", "school", "seed", "sheep", "shoe", "sister", "snow", "song", "squirrel",
    "stick", "street", "sun", "table", "thing", "time", "top", "toy", "tree", "watch",
    "water", "way", "wind", "window", "wood",
    // Grade 4 band (72 words) — later-elementary informational/academic
    // vocabulary, easiest-first (see LEVELS.en "g4").
    "special", "notice", "increase", "material", "although", "consider", "several", "probably", "during", "perhaps",
    "however", "either", "complete", "various", "common", "distance", "product", "method", "section", "direct",
    "single", "effect", "general", "position", "force", "natural", "popular", "difficult", "sentence", "remember",
    "important", "possible", "different", "especially", "system", "program", "example", "group", "area", "level",
    "local", "major", "recent", "result", "simple", "study", "subject", "support", "surface", "total",
    "value", "ready", "sense", "sound", "space", "spread", "stand", "state", "still", "strong",
    "sure", "surprise", "tall", "teach", "term", "thick", "thin", "thought", "throughout", "trouble",
    "usual", "wonder",
    // Grade 5 band (74 words) — see LEVELS.en "g5".
    "vary", "settle", "similar", "compare", "figure", "determine", "include", "indicate", "involve", "require",
    "suggest", "describe", "explain", "discover", "discuss", "examine", "expect", "explore", "express", "identify",
    "imagine", "improve", "inform", "instead", "instruct", "introduce", "locate", "measure", "mention", "observe",
    "occur", "operate", "organize", "perform", "prepare", "present", "prevent", "produce", "protect", "provide",
    "reduce", "refer", "relate", "remain", "removal", "repeat", "replace", "report", "review", "select",
    "separate", "series", "situation", "solve", "source", "specific", "structure", "succeed", "suppose", "survive",
    "adjust", "arrange", "attempt", "average", "avoid", "belong", "combine", "complain", "conclude", "contain",
    "continue", "decide", "deliver", "depend",
    // Grade 6 band (70 words) — see LEVELS.en "g6".
    "represent", "recognize", "particular", "environment", "significant", "communicate", "accomplish", "accurate", "achieve", "acquire",
    "adequate", "advantage", "analyze", "anticipate", "appreciate", "appropriate", "approximate", "assume", "assure", "authority",
    "capable", "capacity", "circumstance", "combination", "component", "comprehend", "concept", "conclusion", "concrete", "conduct",
    "confirm", "consequence", "considerable", "consist", "constant", "construct", "contribute", "convince", "cooperate", "coordinate",
    "correspond", "criteria", "define", "demonstrate", "designate", "distinct", "distribute", "diverse", "domestic", "dominant",
    "efficient", "eliminate", "emphasis", "encounter", "enormous", "essential", "establish", "estimate", "evaluate", "evident",
    "evolve", "exceed", "exclude", "expand", "exceptional", "external", "extreme", "fundamental", "generate", "genuine",
    // Kindergarten band (67 words) — Natalie's classroom sight-word list,
    // kept in the exact order used on her take-home sheet (see LEVELS.en "kg").
    "a", "to", "the", "in", "no", "go", "can", "and", "is", "I",
    "he", "on", "into", "do", "at", "we", "see", "of", "it", "if",
    "has", "had", "not", "all", "be", "put", "so", "up", "said", "was",
    "will", "but", "like", "look", "as", "her", "for", "you", "his", "what",
    "are", "that", "did", "get", "say", "eat", "make", "from", "my", "with",
    "your", "use", "they", "she", "some", "then", "have", "give", "find", "help",
    "went", "off", "best", "yes", "me", "little", "by",
  ],

  // ~200 common German first-reader sight words (Grundwortschatz Klasse 1/2
  // style), ordered roughly easiest/most-frequent first. Nouns capitalized
  // per German orthography (unlike the English list, German nouns ARE
  // included here — that's idiomatic for a German early-reader word bank).
  // Followed by a Klasse-2 band (see LEVELS.de "k2"), appended after.
  de: [
    "der", "die", "das", "und", "ich", "du", "ist", "mit", "auf", "ein",
    "eine", "nicht", "auch", "wir", "ihr", "sie", "er", "es", "was", "wie",
    "wo", "wer", "wann", "warum", "ja", "nein", "hat", "kann", "mag", "mein",
    "dein", "sein", "bin", "bist", "sind", "seid", "habe", "hast", "haben", "habt",
    "war", "waren", "wird", "werden", "oder", "aber", "wenn", "weil", "dass", "noch",
    "schon", "sehr", "viel", "viele", "alle", "alles", "immer", "nie", "jetzt", "heute",
    "morgen", "gestern", "hier", "da", "dort", "dann", "so", "nur", "wieder", "mehr",
    "weniger", "kommt", "geht", "sagt", "spielt", "lacht", "läuft", "malt", "liest", "isst",
    "trinkt", "schläft", "singt", "springt", "sieht", "hört", "macht", "gibt", "nimmt", "fährt",
    "steht", "sitzt", "fliegt", "schwimmt", "tanzt", "weint", "ruft", "holt", "bringt", "zeigt",
    "fragt", "denkt", "weiß", "will", "muss", "soll", "darf", "unter",
    "über", "vor", "hinter", "neben", "zwischen", "durch", "ohne", "um", "nach", "aus",
    "bei", "zu", "von", "für", "in", "an", "rot", "blau", "gelb",
    "grün", "braun", "schwarz", "groß", "klein", "gut",
    "schlecht", "alt", "neu", "schnell", "langsam", "laut", "leise", "schön", "lang",
    "kurz", "warm", "kalt", "hart", "weich", "voll", "leer", "stark", "müde",
    "glücklich", "traurig", "lieb", "nett", "Mama", "Papa", "Oma",
    "Opa", "Bruder", "Schwester", "Kind", "Freund", "Freundin", "Hund", "Katze",
    "Ball", "Haus", "Baum", "Sonne", "Mond", "Stern", "Wasser", "Auto", "Buch", "Schule",
    "Tisch", "Stuhl", "Tür", "Fenster", "Blume", "Vogel", "Fisch", "Maus",
    "Montag", "Dienstag", "Mittwoch",
    "Donnerstag", "Freitag", "Samstag", "Sonntag", "eins", "zwei", "drei", "vier", "fünf", "sechs",
    "sieben", "acht", "neun", "zehn", "bitte", "danke", "hallo", "tschüss", "gern", "gerne",
    "oft", "etwas", "nichts",
    // Klasse-2 Grundwortschatz band (89 words) — see LEVELS.de "k2"
    "Geburtstag", "Ferien", "Familie", "Garten", "Wald", "Wiese", "Tier", "Pferd", "Hase", "Igel",
    "Wetter", "Regen", "Schnee", "Winter", "Sommer", "Frühling", "Herbst",
    "Woche", "Monat", "Jahr", "Stunde", "Minute", "Abend", "Nacht", "Mittag",
    "Brot", "Milch", "Apfel", "Kuchen", "Zimmer", "Küche", "Straße", "Stadt", "Dorf",
    "Fahrrad", "Roller", "Puppe", "Spiel", "Geschichte", "Bild", "Farbe", "Zahl", "Wort", "Satz",
    "Schmetterling",
    "dunkel", "hell", "sauber", "schmutzig", "richtig", "falsch", "fertig", "wichtig", "lustig", "spannend",
    "plötzlich", "gemeinsam", "vorsichtig",
    "freuen", "lachen", "springen", "erzählen", "verstecken", "gewinnen", "verlieren", "arbeiten", "schreiben",
    "rechnen", "turnen", "basteln", "wandern", "träumen", "füttern",
    "zusammen", "vielleicht", "endlich", "sofort", "zuerst", "danach", "draußen", "drinnen", "oben", "unten",
    "links", "rechts", "gegen", "seit", "damit", "darum",
    // Klasse-3 band (72 words) — later-elementary vocabulary continuing
    // past Klasse-2, easiest-first (see LEVELS.de "k3").
    "Verkehr", "Umwelt", "Abenteuer", "erklären", "Werkzeug", "Nachbar", "Feuerwehr", "Polizei", "Krankenhaus", "Apotheke",
    "Bäckerei", "Supermarkt", "Bahnhof", "Flughafen", "Fabrik", "Büro", "Werkstatt", "Baustelle", "Brücke", "Turm",
    "Burg", "Schloss", "Insel", "Berg", "Fluss", "See", "Meer", "Küste", "Wüste", "Dschungel",
    "Höhle", "Feld", "Ernte", "Bauer", "Traktor", "Maschine", "Motor", "Reifen", "Bremse", "Kreuzung",
    "Ampel", "Schild", "Landkarte", "Kompass", "Norden", "Süden", "Osten", "Westen", "Richtung", "Ausflug",
    "Urlaub", "Koffer", "Zelt", "Rucksack", "Fernglas", "Taschenlampe", "Batterie", "Strom", "Energie", "Recycling",
    "Müll", "sammeln", "entdecken", "bauen", "reparieren", "planen", "packen", "besuchen", "beobachten", "retten",
    "schützen", "reisen",
    // Klasse-4 band (69 words) — see LEVELS.de "k4".
    "Gesellschaft", "Erfahrung", "vergleichen", "untersuchen", "Wissenschaft", "Experiment", "Ergebnis", "Beobachtung", "Erfindung", "Entdeckung",
    "Bibliothek", "Zeitung", "Nachricht", "Information", "Meinung", "Vorschlag", "Entscheidung", "Lösung", "Aufgabe", "Projekt",
    "Gruppe", "Klassenzimmer", "Unterricht", "Prüfung", "Note", "Zeugnis", "Wettbewerb", "Mannschaft", "Regel", "Ordnung",
    "Sicherheit", "Gefahr", "Unfall", "Warnung", "Vorsicht", "Rücksicht", "Höflichkeit", "Respekt", "Streit", "Versöhnung",
    "Freundschaft", "Vertrauen", "Geheimnis", "Überraschung", "Enttäuschung", "Aufregung", "Erwartung", "Hoffnung", "Neugier", "erforschen",
    "beschreiben", "begründen", "vermuten", "behaupten", "bezweifeln", "bemerken", "erinnern", "vergessen", "verstehen", "begreifen",
    "erfahren", "erleben", "gestalten", "entwickeln", "verändern", "verbessern", "wiederholen", "überprüfen", "feststellen",
    // Klasse-5 band (70 words) — see LEVELS.de "k5".
    "Kultur", "Tradition", "Vergangenheit", "Zukunft", "Gegenwart", "Jahrhundert", "Jahrzehnt", "Epoche", "Ereignis", "Entwicklung",
    "Fortschritt", "Erfolg", "Misserfolg", "Herausforderung", "Fähigkeit", "Eigenschaft", "Charakter", "Persönlichkeit", "Verhalten", "Gewohnheit",
    "Einstellung", "Ansicht", "Standpunkt", "Argument", "Beweis", "Behauptung", "Tatsache", "Wahrheit", "Wirklichkeit", "Vorstellung",
    "Fantasie", "Kreativität", "Geduld", "Ausdauer", "Mut", "Ehrlichkeit", "Gerechtigkeit", "Gleichheit", "Freiheit", "Frieden",
    "Konflikt", "Kompromiss", "Zusammenarbeit", "Unterstützung", "Hilfsbereitschaft", "Rücksichtnahme", "Toleranz", "Zuverlässigkeit", "Selbstständigkeit", "Neugierde",
    "bewerten", "einschätzen", "diskutieren", "argumentieren", "überzeugen", "widersprechen", "zustimmen", "ablehnen", "vorschlagen", "beraten",
    "organisieren", "koordinieren", "verwalten", "leiten", "entscheiden", "vertreten", "unterstützen", "ermutigen", "motivieren", "inspirieren",
    // Klasse-6 band (67 words) — see LEVELS.de "k6".
    "Verantwortung", "Möglichkeit", "Einfluss", "analysieren", "Wirtschaft", "Politik", "Demokratie", "Gesetz", "Recht", "Pflicht",
    "Bürger", "Staat", "Regierung", "Verwaltung", "Institution", "Organisation", "Struktur", "System", "Prinzip", "Grundlage",
    "Voraussetzung", "Bedingung", "Faktor", "Ursache", "Wirkung", "Folge", "Auswirkung", "Konsequenz", "Zusammenhang", "Beziehung",
    "Verbindung", "Abhängigkeit", "Unabhängigkeit", "Perspektive", "Blickwinkel", "Interpretation", "Bedeutung", "Definition", "Begriff", "Konzept",
    "Theorie", "Methode", "Verfahren", "Vorgehen", "Strategie", "Technik", "Instrument", "Ausrüstung", "Substanz", "Element",
    "Komponente", "Bestandteil", "identifizieren", "interpretieren", "formulieren", "rechtfertigen", "verallgemeinern", "spezifizieren", "kombinieren", "integrieren",
    "unterscheiden", "einordnen", "reflektieren", "kritisieren", "erweitern", "einbeziehen", "berücksichtigen",
  ],
};

// Reading-level entry points, as indices into the flat WORDS lists above.
// A kid's chosen level for a language determines where new-word
// introduction STARTS — words before startIndex are treated as "assumed
// known" and never introduced as new, though any of them that already have
// stored progress (e.g. from before a level was raised) still review
// normally. See levelStartIndex() in app.js.
const LEVELS = {
  en: [
    { id: "kg", startIndex: 531 },  // Kindergarten band, appended after the Grade-6 band
    { id: "prek", startIndex: 0 },
    { id: "g1", startIndex: 92 },   // after pre-primer(40) + primer(52)
    { id: "g23", startIndex: 133 }, // after first grade(41)
    { id: "g4", startIndex: 315 },  // after second/third grade(46+41) + Dolch nouns(95)
    { id: "g5", startIndex: 387 },  // after the Grade-4 band(72)
    { id: "g6", startIndex: 461 },  // after the Grade-5 band(74)
  ],
  de: [
    { id: "prek", startIndex: 0 },
    { id: "k1", startIndex: 60 },   // after the 60 core Vorschule words (der..heute)
    { id: "k2", startIndex: 210 },  // after the existing Klasse-1 words
    { id: "k3", startIndex: 299 },  // after the existing Klasse-2 words
    { id: "k4", startIndex: 371 },  // after the Klasse-3 band(72)
    { id: "k5", startIndex: 440 },  // after the Klasse-4 band(69)
    { id: "k6", startIndex: 510 },  // after the Klasse-5 band(70)
  ],
};
