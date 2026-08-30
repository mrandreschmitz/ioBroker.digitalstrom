![Logo](admin/digitalstrom.png)
# ioBroker.digitalstrom

[![NPM version](http://img.shields.io/npm/v/iobroker.digitalstrom.svg)](https://www.npmjs.com/package/iobroker.digitalstrom)
[![Downloads](https://img.shields.io/npm/dm/iobroker.digitalstrom.svg)](https://www.npmjs.com/package/iobroker.digitalstrom)
![Test and Release](https://github.com/mrandreschmitz/ioBroker.digitalstrom/workflows/Test%20and%20Release/badge.svg)

**English version: [README.md](README.md)**

## Digitalstrom-Adapter für ioBroker

Anbindung von digitalSTROM-Geräten über den DSS (digitalSTROM-Server)

> Dies ist ein gepflegter Fork von [ioBroker/ioBroker.digitalstrom](https://github.com/ioBroker/ioBroker.digitalstrom)
> von Apollon77, der seit 2021 nicht mehr aktualisiert wurde. Die zugrunde liegende Bibliotheksschicht
> wurde ersetzt, der Admin-Dialog auf JsonConfig migriert und eine größere Zahl von Laufzeitfehlern
> behoben. Einzelheiten stehen im Changelog.
>
> Dieser Fork sendet **keine** Fehlerberichte: Das Sentry-Plugin des Originaladapters wurde entfernt,
> weil dessen Berichte in einem Projekt der ioBroker-Organisation gelandet wären, auf das dieser Fork
> keinen Zugriff hat.

## Installation

Die Installation erfolgt wie gewohnt über die Admin-Oberfläche.

Zum Testen neuerer Versionen kann der Adapter auch direkt von GitHub installiert werden. Verwende dazu
in Admin die Option „Beliebig / Custom Install" mit der URL
https://github.com/mrandreschmitz/ioBroker.digitalstrom.

## Verwendung

Nach der Installation und dem Anlegen einer Instanz erscheint der Admin-Dialog.
Zuerst trägst du IP-Adresse oder Hostnamen deines DSS ein. Danach kannst du entweder einen bereits im
DSS-Webinterface erzeugten App-Token eintragen oder Benutzername und Passwort angeben, damit der
Adapter automatisch einen App-Token erstellt.

Zusätzlich zu den Anmeldedaten stehen folgende Einstellungen zur Verfügung:

* **Datenabfrageintervall**: Intervall, in dem die Zählerdaten („Energy Meter") von den dSM-Geräten
  abgefragt werden. Standard 100 s, Minimum 60 s. Die digitalSTROM-Regeln 8 und 9 erlauben höchstens
  einen zyklischen Lesezugriff pro Minute und Klemme. Ein Zyklus liest zwei Werte je Klemme
  (`getConsumption` und `getEnergyMeterValue`), und der Timer für den nächsten Zyklus startet erst,
  wenn beide beantwortet sind — ein Zyklus dauert dadurch rund 20 s länger als das eingestellte
  Intervall. An einer echten Anlage gemessen: 60 s ergeben ~1,5 Anfragen pro Minute und Klemme,
  100 s genau 1,0. Deshalb ist 100 s der Standard. Kleinere Werte bleiben ab 60 s möglich,
  überschreiten die Vorgabe aber. Mit `0` wird die Abfrage vollständig deaktiviert. Ungültige Werte
  fallen auf den Standard zurück.
* **Szenen-Preset-Werte verwenden**: Das digitalSTROM-System ist nicht darauf ausgelegt, die echten
  Ausgangswerte der Geräte ständig bereitzuhalten, sondern arbeitet überwiegend mit Szenen. Für Licht
  und Rollladen/Jalousie sind für viele Szenen Ausgangswerte definiert. Der Adapter kennt diese Werte
  und schreibt sie bei einem Szenenaufruf sofort in die States; die echten Werte werden verzögert
  nachgelesen. Bei gesetzten lokalen Prioritäten kann diese Methode falsche Werte liefern.
* **Geräte-Ausgangswerte aktiv abfragen**: Der Adapter liest die Ausgangswerte aller Geräte beim Start
  und nach Szenen, die ein Gerät betreffen. Diese Abfragen laufen über den digitalSTROM-Bus. Falls das
  in deiner Installation stört, kannst du die Funktion abschalten. Die Option steuert **ausschließlich
  das Lesen** von Ausgangswerten. Das **Schreiben** (Jalousieposition, Lamellenwinkel, Dimmwert)
  funktioniert unabhängig davon immer.
* **Unbekannte Objekte beim Start löschen**: Ist die Option aktiv, werden beim Adapterstart alle
  ioBroker-Objekte gelöscht, die nicht Teil der aktuellen DSS-Struktur sind. Achtung: Auch Objekte von
  nur vorübergehend nicht erreichbaren Geräten (z. B. einer stromlosen Klemme) werden gelöscht —
  einschließlich ihrer eigenen Einstellungen wie History- oder InfluxDB-Konfiguration. Deshalb ist die
  Option standardmäßig aus; verwaiste Objekte werden dann nur im Log aufgelistet.
* **TLS-Zertifikat des DSS prüfen**: Standardmäßig wird das Zertifikat des DSS nicht geprüft, weil der
  DSS ein selbstsigniertes Zertifikat verwendet. Aktiviere die Option nur, wenn dein DSS ein gültiges
  Zertifikat besitzt. Siehe den folgenden Sicherheitshinweis.

### Sicherheitshinweis zur Zertifikatsprüfung

Die Option **TLS-Zertifikat des DSS prüfen** ist standardmäßig deaktiviert und bleibt es auch — ein
digitalSTROM-Server wird mit einem selbstsignierten Zertifikat ausgeliefert, eine standardmäßig
aktivierte Prüfung würde also jede bestehende Installation lahmlegen.

Was das bedeutet: Die Verbindung zum DSS ist verschlüsselt, aber der Adapter überprüft nicht, *mit wem*
er spricht. In einem Netzwerk, das du selbst kontrollierst, ist das in der Regel vertretbar. Wer den
Datenverkehr innerhalb deines Netzwerks umleiten kann (ARP-Spoofing, kompromittierter Router,
unvertrauenswürdiges WLAN), könnte sich jedoch zwischen ioBroker und DSS setzen und würde dann den
App-Token und jeden Befehl mitlesen.

Empfehlungen, in dieser Reihenfolge:

1. Betreibe DSS und ioBroker in einem vertrauenswürdigen, abgetrennten Netzsegment und route die
   Verbindung zum DSS nicht über das Internet oder ein fremdes WLAN.
2. Besitzt dein DSS ein Zertifikat aus einer eigenen CA oder von einer öffentlichen CA (z. B. hinter
   einem Reverse Proxy mit gültigem Zertifikat), trage diesen Hostnamen ein und aktiviere die Option.
3. Migrationspfad für eine Prüfung mit dem originalen, selbstsignierten Zertifikat: Dafür wird das
   Zertifikat selbst benötigt. Der Adapter unterstützt derzeit weder eine eigene CA-Datei noch einen
   Zertifikats-Fingerprint. Technisch wäre beides möglich (`ca` bzw. `checkServerIdentity` des
   Node.js-TLS-Agents) und ist als mögliche Erweiterung vorgemerkt. Bis dahin sind Weg 1 oder 2 die
   richtige Wahl.

Der App-Token wird verschlüsselt gespeichert (`encryptedNative`), nicht an andere Adapter
weitergegeben (`protectedNative`), nicht ins Log geschrieben und im Admin-Dialog maskiert dargestellt.

Nach dem Eintragen des App-Tokens und dem Speichern startet der Adapter automatisch neu.

Stimmen die Daten, liest der Adapter die Wohnungs- und Gerätestruktur aus und legt sie als
ioBroker-Objekte an. Das kann je nach Anzahl der Geräte, Etagen, Räume und Gruppen sowie der Leistung
deines Systems einige Zeit dauern. Bitte hab Geduld — und das ist ernst gemeint: Mehrere tausend
Objekte sind hier schnell erreicht.

Danach abonniert der Adapter mehrere DSS-Events, um über Aktionen im System benachrichtigt zu werden.

Die Statusanzeige des Adapters wird grün und im Log erscheint „Subscribed to states …". Ab diesem
Moment ist alles bereit und du kannst zum Beispiel:

* Szenen für Wohnung, Räume, Gruppen oder einzelne Geräte aufrufen und zurücknehmen
* Status- und Sensorwerte lesen; bei Räumen können Sensorwerte auch gesetzt werden
* Werte von Binäreingängen, Sensoren, Tastern und Ausgängen sehen

## Objekt- und State-Struktur

Der Adapter stellt zwei Datenstrukturen bereit: die Wohnungsstruktur mit Etagen, Räumen (Zonen) und
Gruppen sowie zusätzlich die Struktur der Klemmen/dSMs mit den daran angeschlossenen Geräten und
deren Detaildaten.

In den Strukturen kommen mehrere Datentypen vor:

* **Szenen** sind als Schalter umgesetzt. Der Wert `true` sendet einen `callScene`-Befehl für diese
  Szene, der Wert `false` einen `undoScene`-Befehl — ob „undo" ein gültiger Befehl ist, entscheidet
  der DSS. Löst der DSS selbst ein `callScene` oder `undoScene` als Event aus, wird die betroffene
  Szene mit `ack=true` auf `true` bzw. `false` gesetzt.
* **States** aus dem System und benutzerdefinierte States über das Addon werden angezeigt und sind
  schreibgeschützt.
* **Sensorwerte** werden über Events aktualisiert und können teilweise auch geschrieben werden.
  Änderungen werden als `pushSensorValue` an den Server geschickt; ob der Wert akzeptiert wird,
  entscheidet der Server. Relevant ist das vor allem für Temperatur- und Feuchtewerte.

### Objekte und States der Wohnung

![Apartment Objects](img/dss-apartment.png)

Für die Wohnung wird eine Struktur „Etage"."Raum" angelegt, darunter jeweils:

* pro Gerätegruppe ein Unterordner mit den verfügbaren Gruppenszenen
* die Szenen dieses Raums
* die States dieses Raums
* die Sensorwerte dieses Raums

Auf Wohnungsebene sind alle Gerätegruppen mit ihren Szenen verfügbar. Ebenfalls auf Wohnungsebene
liegen Sensoren (auch Außenwerte), States und benutzerdefinierte States.

### Objekte und States der Geräte

![Devices Objects](img/dss-devices.png)

Die Geräte sind als „Klemme/dSM"."Geräte-ID" strukturiert, darunter jeweils:

* Geräteszenen, die ausschließlich dieses Gerät ansprechen
* Gerätesensoren, sofern vom System gemeldet — Werte können also leer bleiben
* Ausgangswerte (z. B. Helligkeit bei Licht, Position und Winkel bei Rollladen/Jalousie) direkt
  unterhalb des Geräts. Eine definierte Funktionalität gibt es bisher nur für Licht und
  Rollladen/Jalousie.
* Taster und Binäreingänge, ebenfalls als States und schreibgeschützt

## Hinweise zum Verhalten

* **Schnelle aufeinanderfolgende Schreibvorgänge**: Wird ein neuer Wert auf denselben Ausgang
  geschrieben, während ein älterer noch in der Warteschlange steht, ersetzt der neuere den älteren
  (Last-write-wins), um die Anfragegrenzen des DSS einzuhalten. Der ersetzte Auftrag wird als
  „superseded" gemeldet und sein Wert nie als geschrieben quittiert. Ein bereits an den DSS gesendeter
  Schreibvorgang wird nie ersetzt — der neuere Wert geht danach raus.
* **Hostfeld**: Akzeptiert werden IP-Adressen, DNS-Namen, vollständige URLs und IPv6-Adressen (in
  eckigen Klammern). Ohne expliziten Port wird 8080 verwendet. Anmeldedaten, Pfade oder Query-Strings
  im Hostfeld werden abgelehnt.

## Bekannte Einschränkungen und Systemeigenheiten

* Das DSS-System arbeitet überwiegend mit Szenen statt mit echten Gerätewerten. Das Auslesen echter
  Werte ist zudem langsam, weil es über den Bus laufen muss.
* Werte können leer bleiben, wenn das System sie nicht meldet.
* Binäreingänge wurden ursprünglich ohne passende Geräte zum Testen implementiert. Inzwischen ist
  belegt, dass sie funktionieren: Bewegungsmelder und Fenstergriffe melden darüber. Der Zustand behält die
  Zahl, die der DSS meldet, damit Verlaufsdaten vergleichbar bleiben, die Zahlen sind aber benannt:
  `inactive`/`active` bei einem normalen Binäreingang und `closed`/`open`/`tilted` bei einem
  Fenstergriff, der drei statt zwei Stellungen meldet.
* Sinnvolles Lesen und Schreiben von Ausgangswerten ist bisher nur für Licht (Gelb) und
  Rollladen/Jalousie (Grau) umgesetzt.
* Das Verhalten mit vDCs konnte bisher nicht geprüft werden. Auch dafür werden Logs und Details
  benötigt.
* Die Raumtemperaturregelung ist für die Räume umgesetzt, die der DSS tatsächlich regelt: Reglermodus
  und Reglerzustand werden gelesen, der Betriebsmodus folgt den Szenen der Gruppe 48 und ist
  schreibbar, und der Sollwert jedes Betriebsmodus wird gelesen und kann geändert werden. Räume ohne
  aktiven Regler erhalten bewusst keine dieser Objekte.
* Die Lüftung ist über die Gruppenszenen, den Lüftungsstatus der Wohnung und die beiden booleschen
  Ausgangskanäle (Schwenkmodus, automatische Intensität) abgedeckt. Darüber hinaus haben
  Lüftungsgeräte keine eigene Funktionalität, da keine passende Hardware zum Testen vorlag. Logs und
  Rückmeldungen sind willkommen.

## Fehler melden und Funktionswünsche

Bitte nutze dafür die [Issues dieses Forks](https://github.com/mrandreschmitz/ioBroker.digitalstrom/issues).

Am hilfreichsten ist es, den Adapter auf den Loglevel „debug" zu stellen (Instanzen → Expertenmodus →
Spalte Loglevel) und die Logdatei anschließend von der Festplatte zu holen (Unterverzeichnis `log` im
ioBroker-Installationsverzeichnis, nicht aus dem Admin — dort werden Zeilen abgeschnitten). Bitte gib
im Issue an, was zu welchem Zeitpunkt im Log zu sehen sein sollte.

## Danksagung und Lizenz

Dieser Adapter wurde ursprünglich von **Apollon77 &lt;iobroker@fischer-ka.de&gt;** geschrieben und unter
der MIT-Lizenz auf [ioBroker/ioBroker.digitalstrom](https://github.com/ioBroker/ioBroker.digitalstrom)
veröffentlicht. Das Verdienst an der ursprünglichen Arbeit gebührt ihm.

Dieses Repository ist ein Fork, der die Pflege ab Version 2.4.0 fortsetzt (André Schmitz, 2026). Es
wird unter derselben MIT-Lizenz veröffentlicht; der ursprüngliche Copyright-Hinweis bleibt in
[LICENSE](LICENSE) unverändert erhalten.

## Changelog

Der vollständige Changelog inklusive der Historie von Apollon77 steht in der englischen Fassung:
[README.md](README.md#changelog). Hier die Einträge der gepflegten Versionen auf Deutsch.

### 2.4.9 (2026-08-30)

* **Ungültige Admin-Konfiguration behoben.** Die beiden Trennlinien des in 2.4.5 eingeführten
  Layouts trugen eine Farbe aus der digitalSTROM-Palette, das Schema erlaubt für diese
  Eigenschaft aber nur `primary` und `secondary`. Admin wies die gesamte Konfiguration mit
  `digitalstrom has an invalid jsonConfig` zurück und fiel auf einen generischen Dialog zurück.
  Die Farbe steht jetzt in `style`/`darkStyle`, wo eine freie Farbe zulässig ist. Zwei neue
  Tests prüfen die enum-beschränkten Eigenschaften des Schemas, damit diese Fehlerklasse nicht
  unbemerkt zurückkommen kann.
* Der Release-Workflow dieses Forks versucht nicht mehr, auf npm zu veröffentlichen — der
  Paketname gehört dem Ursprungsprojekt. Ein gepushter Tag `v<Version>` erzeugt jetzt nur noch
  das GitHub-Release, dessen Text aus der Nachricht des annotierten Tags stammt.

### 2.4.8 (2026-08-30)

* Der Hinweis zur App-Token-Migration wurde aus dem Admin-Dialog und aus dem Readme entfernt.
  Keine veröffentlichte Version enthielt die falsch platzierte `encryptedNative`-Deklaration —
  ein dauerhafter Hinweis auf eine Migration, die niemand durchführen muss, würde nur verwirren.
  Der Adapter erkennt weiterhin einen Token, den er nicht zurücklesen kann, und meldet das im
  Log, jetzt ohne Bezug auf eine Versionshistorie.

### 2.4.7 (2026-08-30)

* **Das Datenabfrageintervall steht standardmäßig auf 100 s statt 60 s.** An einer produktiven
  Anlage mit 6 Zählerklemmen gemessen: Ein Zyklus liest zwei Werte je Klemme (`getConsumption` +
  `getEnergyMeterValue`), und der Timer für den nächsten Zyklus startet erst, wenn beide
  beantwortet sind — ein Zyklus dauert dadurch rund 20 s länger als das eingestellte Intervall.
  Mit 60 s ergab das gemessene 1,53 Anfragen pro Minute und Klemme, also das Anderthalbfache
  dessen, was die digitalSTROM-Regeln 8/9 erlauben. 100 s ergibt einen Zyklus von etwa 120 s und
  damit genau 1,0. Die Aussage aus 2.4.4, 60 s halte diese Regeln ein, zählte nur einen Read pro
  Zyklus und war falsch. Das Minimum bleibt bei 60 s: Kleinere Werte sind weiterhin möglich, sie
  werden jetzt nur ehrlich als Überschreitung dokumentiert statt als regelkonform bezeichnet.

### 2.4.6 (2026-08-30)

Entstanden aus dem Objekt-Export und dem Debug-Log einer produktiven Installation.

* **Raumtemperaturregelung.** Jeder Raum, den das DSS wirklich regelt, bekommt einen Kanal
  `temperatureControl` mit `ControlMode` (Art des Reglers), `ControlState` (wer den Sollwert
  besitzt) und `OperationMode` — einer lesbaren, schaltbaren Entsprechung der Szenen von
  Gruppe 48, die jedem Szenenaufruf folgt. Räume mit `ControlMode: 0` bleiben bewusst ohne
  diese Objekte, damit auf einen Blick erkennbar ist, welche Räume überhaupt geregelt werden.
* **Sollwerte je Betriebsart.** Sie werden über `zone/getTemperatureControlValues` gelesen und
  über `zone/setTemperatureControlValues` geschrieben. Die Feldnamen kommen aus der Antwort
  statt fest im Code zu stehen, und die States entstehen nur, wenn das DSS wirklich
  geantwortet hat — eine Firmware ohne diesen Endpunkt bekommt keine toten Objekte.
* `NominalValue` bleibt beschreibbar, wirkt aber nur bei externer Regelung
  (`ControlState` = extern). Beim internen Regler überschreibt das DSS den eingespeisten Wert
  — dafür sind `OperationMode` und die Sollwerte da.
* **Cluster-States.** `cluster.<id>.user_lock` und `cluster.<id>.operation_lock` hatten
  überhaupt kein Objekt, obwohl der Gruppenordner des Clusters existiert. Sie werden jetzt
  unterhalb von `apartment.groups.<id>.states` angelegt.
* **Gruppen-States mit Punkt im Namen.** `status.malfunction` und `status.service` der
  Lüftungsgruppen wurden von einem Muster verworfen, das nur ein Segment erlaubte. Sie
  entstehen jetzt als verschachtelte States, inklusive des Kanals dazwischen.
* Die Prüfung auf Räume ohne Etage wertete `isValid` als reine Truthiness aus. Ein echtes DSS
  sendet dieses Flag bei Zonen gar nicht, wodurch die Prüfung vollständig stumm war. Jetzt wird
  nur noch eine Zone übersprungen, die das DSS ausdrücklich als ungültig oder als nicht
  vorhanden meldet (`isPresent: false`, z. B. die dS-Zone 65534 für nicht zugeordnete Geräte).

### 2.4.5 (2026-08-30)

* Admin-Konfiguration neu gestaltet. Die Optionen liegen jetzt in den Reitern **Verbindung**,
  **Einstellungen** und **Hinweise** statt auf einer langen Seite — mit Abschnittsüberschriften,
  Hinweisboxen und Schalterkarten in den digitalSTROM-Farben (`#00662E` / `#7FC241`, aus dem Logo
  entnommen).
* Der neue Reiter **Hinweise** erklärt die Zertifikatsprüfung.
* Keine Option wurde umbenannt oder entfernt — bestehende Instanzeinstellungen werden unverändert
  übernommen. Ein Test prüft jetzt, dass jede Option aus `native` weiterhin ein Bedienelement hat.

### 2.4.4 (2026-08-14)

Gefunden durch eine systematische Multi-Agenten-Prüfung des gesamten Adapters. Alle diese Defekte
existierten bereits in 2.4.2 und früher — sie schlagen still fehl, deshalb sind sie nie als Fehler
aufgefallen.

* **Eine Szene für einen ganzen Raum erreichte die Geräte-Handler nie.** `zoneDevices` ist nur nach
  den echten Gerätegruppen (1, 2, 8 …) indiziert, nie nach der Broadcast-Gruppe 0 — der Fan-out
  fand also nichts, und die anschließende Weiterleitungsschleife ist als „forwarded" markiert, was
  ihn ebenfalls abschaltet. Folge: Nach jedem „Raum aus" behielten `brightness`,
  `shadePositionOutside` und `shadeOpeningAngle*` ihren alten Wert, bis zufällig eine Gruppenszene
  dasselbe Gerät traf oder der Adapter neu startete — ohne eine einzige Logmeldung. Der Adapter
  löst diesen Fall selbst aus: Seine eigenen Raum-Szenen-States senden `zone/callScene` ohne
  groupID.
* **Der App-Token wird jetzt wirklich verschlüsselt gespeichert.** `encryptedNative` und
  `protectedNative` standen innerhalb von `common` statt in der Wurzel der io-package.json, wo
  `ioBroker.AdapterObject` sie erwartet. Beides war damit wirkungslos: Der Token lag im Klartext in
  der Objektdatenbank, war für jeden anderen Adapter lesbar und stand unverschlüsselt in jedem
  Backup. **Migration:** Ein von einer älteren Version gespeicherter Token lässt sich nicht
  entschlüsseln und kommt als Müll zurück. Öffne einmal die Adapter-Konfiguration, trage den
  App-Token erneut ein (oder erstelle mit deinen DSS-Anmeldedaten einen neuen) und speichere. Der
  Adapter erkennt diesen Fall jetzt und sagt genau das, statt nur einen fehlgeschlagenen Login zu
  melden.
* **Bei manchen Geräten wurde jeder Druck auf den ersten Taster verworfen.** Der State von Taster 0
  entstand nur bei `buttonActiveGroup` 1..8, während Klicktyp und Haltedauer desselben Tasters
  immer angelegt wurden — und der Event-Handler bricht ab, wenn der einfache Taster-State fehlt.
  Bei einem Tastenfeld mit nicht zugewiesenem Taster, auf Broadcast oder in einer Gruppe über 8
  funktionierten die Taster 2..n, während Taster 1 nur `INVALID Button click` erzeugte.
* Klicktyp und Haltedauer wurden als DSS-Rohstring in einen als Zahl deklarierten State
  geschrieben — js-controller warnte bei jedem Tastendruck und die `states`-Zuordnung griff nicht.
* `EXTRANOUS ZONE found <id>` wurde bei jedem Adapterstart für jeden regulären Raum geloggt: Die
  Prüfung lief synchron, während die Räume über `setImmediate` verarbeitet werden — ihre
  Buchführung war zu dem Zeitpunkt noch leer.
* **„Geräte-Ausgangswerte aktiv abfragen" = aus unterdrückte auch die Szenen-Preset-Werte.** Die
  Option steuert laut Dokumentation nur die Lesezugriffe; die Preset-Werte gehören zu
  „Szenen-Preset-Werte verwenden". Der Gate saß vor dem Geräte-Handler statt vor dem Lesezugriff.
* Der Ausgangskanal `shadePositionIndoor` hieß „Shade Position **Outside** (curtains)". Bestehende
  Objekte behalten ihren alten Namen — ioBroker bewahrt den Namen bei Updates.

### 2.4.3 (2026-08-12)

**Laufzeitfehler**

* Die Event-Wiederherstellung konnte dauerhaft hängen bleiben: Ein erfolgreiches `event/subscribe`
  setzte den Fehlerzähler zurück, sodass ein DSS, der das Abonnement annahm, aber jedes `event/get`
  mit HTTP 500 beantwortete, den Grenzwert nie erreichte. Der Adapter blieb grün und abonnierte alle
  zwei Sekunden neu, ohne je wieder ein Event zu verarbeiten. Der Zähler wird jetzt nur noch von einem
  tatsächlich erfolgreichen `event/get` gelöscht, der Backoff wächst, und der vorgesehene
  `eventError`-/Neustart-Weg wird zuverlässig erreicht.
* Der Stop ist jetzt eine echte Barriere: Asynchrone Startup-Callbacks, die während oder nach dem
  Entladen fertig werden, erzeugen keine Timer, Requests, State-Subscriptions und kein
  `connected = true` mehr. `DSS.requestAsync()` und `httpRequest()` lehnen nach `stop()` jede Anfrage
  ab, und ein noch laufender App-Token-Dialog wird beim Entladen verfolgt und geschlossen (keine
  verspäteten `sendTo`-Aufrufe und keine späten Logmeldungen aus diesem Ablauf).
* **Geräte-Ausgangswerte aktiv abfragen = aus** deaktivierte die gesamte Jalousiesteuerung: Erkennung
  von Position und Winkel, die Schreibhandler und das Initial-Lesen lagen in einem gemeinsamen Block,
  sodass bei ausgeschalteter Option überhaupt kein Schreibbefehl mehr am DSS ankam. Das Schreiben ist
  jetzt unabhängig von der Option, die nur noch steuert, ob Ausgangswerte *gelesen* werden (initial
  und nach Szenenereignissen, für Jalousien wie für Licht).
* Szene 22 und Szene 25 hießen beide „Preset 24" und teilten sich dadurch eine State-ID. Der
  verbleibende Handler steuerte Szene 25, Szene 22 war nicht erreichbar. Szene 22 heißt wieder
  „Preset 14" (wie es der Kommentar im Code bereits sagte), und ein Test prüft jetzt alle erzeugten
  Szenen-State-IDs auf Eindeutigkeit.
* Das Queue-Coalescing ist re-entrant: Der Queue-Eintrag wird ersetzt, *bevor* die Superseded-Callbacks
  laufen. Ein Wert, der synchron aus einem Superseded-Callback eingereiht wird (typisch für einen
  weiterbewegten Schieberegler), wird nicht mehr vom älteren Aufruf überschrieben. Garantiert ist:
  Der neueste Wert wird genau einmal gesendet, ein ersetzter Wert wird nie gesendet, jeder Callback
  wird genau einmal beendet, kein Callback geht verloren.
* Ein ersetzter Schreibvorgang wird nicht mehr als Warnung gemeldet. Die Meldung
  `Error while set State for apartment-user: SupersededError: … was superseded by a newer value` war
  normales Last-write-wins-Coalescing und kein DSS-Fehler. Erwartete Queue-Abbrüche werden jetzt
  zentral klassifiziert (`DSSQueue.isExpectedQueueError`) und für alle Consumer (apartment,
  apartment-user, circuit, device/output, zone, group) nur noch als Debug protokolliert. Echte
  Netzwerk-, DSS- und Antwortfehler erzeugen weiterhin eine Warnung.
* Beim Start konnten Events verloren gehen: Die Handler wurden erst registriert, nachdem *alle*
  Subscriptions abgeschlossen waren, während jede einzelne Subscription sofort nach ihrem Erfolg zu
  pollen beginnt. Die Handler werden jetzt registriert, bevor der erste Poll etwas ausliefern kann
  (und niemals doppelt). Zusätzlich entfiel die künstliche Wartezeit von zwei Sekunden vor dem
  Abonnieren, und sobald die Subscription aktiv ist, werden die zuletzt aufgerufenen Szenen einmal mit
  niedrigster Priorität abgeglichen, sodass Szenenaufrufe während eines langen Starts nachträglich
  angewendet werden.

**Weitere Fehlerbehebungen**

* Die booleschen Ausgangskanäle `airLouverAuto` (Schwenkmodus der Lüftung) und `airFlowAuto`
  (automatische Lüftungsintensität) akzeptierten nur Zahlen und wiesen `true`/`false` zurück. Sie sind
  wieder schaltbar und werden als 0/1 an den DSS gesendet. Ungültige Typen werden weiterhin
  kontrolliert abgelehnt.
* Der Ventilationsstatus der Wohnung (Sensor 60) wurde als Boolean angelegt, wodurch jeder Statuscode
  ungleich 0 zu `true` wurde. Er ist wieder ein numerischer State und behält alle DSS-Statuscodes
  (0 = OK, 2 = Störung, 4 = Service, 6 = Störung + Service).
* Heizungs- und Ventilationsgruppen aktivierten beim Start den generischen Szenen-State (z. B.
  `Preset0`), während jedes Event den speziellen (z. B. `HeatingOff`) umschaltete. Der Initialzustand
  wird jetzt über die State-Map aufgelöst, genau wie in der Eventverarbeitung.
* Apartment-spezifische Clusternamen lecken nicht mehr zwischen Adapterinstanzen: Jede Struktur erhält
  eine eigene Kopie der Gruppentyp-Tabelle, und die Modulkonstanten werden zur Laufzeit nie verändert.
* Host-Normalisierung: Ein explizit konfigurierter Standardport wurde durch den DSS-Standardport 8080
  ersetzt, wenn der Host mit einem Schrägstrich endete (`https://dss.local:443/` wurde zu
  `https://dss.local:8080`, ebenso bei `http://…:80/` und IPv6). Behoben für Hostnamen, IPv4 und IPv6,
  mit und ohne abschließenden Schrägstrich.
* Ein vom Adapter selbst erzeugter Request-Timeout trägt jetzt eine strukturierte Kennzeichnung
  (`code: 'ETIMEDOUT'`), sodass der Retry-Klassifikator ihn erkennt und ein sicherer Lesezugriff einmal
  wiederholt wird. Schreibzugriffe werden weiterhin nie wiederholt.
* `apartment/getReachableGroups` (ein reiner Lesezugriff beim Start) darf nach einem Verbindungsfehler
  einmal wiederholt werden.

**Konfiguration und Wartung**

* Das minimale Datenabfrageintervall beträgt jetzt 60 s statt 10 s. Die digitalSTROM-Regeln 8 und 9
  erlauben höchstens einen zyklischen Lesezugriff pro Minute und Klemme, und ein Zyklus erzeugt bereits
  mehrere Messwert-Reads pro Klemme. Konfigurierte Werte zwischen 1 und 59 werden auf 60 s angehoben,
  `0` deaktiviert die Abfrage weiterhin vollständig. **Wenn du einen Wert unter 60 s eingestellt hast,
  ändert sich mit diesem Update das tatsächliche Intervall.**
* Der App-Token wird im Admin-Dialog nicht mehr im Klartext angezeigt (gespeichert war er bereits
  verschlüsselt und geschützt).
* CodeQL von der nicht mehr unterstützten Version v2 auf v4 aktualisiert.
* Node.js 22 ist die neue Mindestversion (Node 20 hat das Supportende erreicht), CI und Release laufen
  auf Node 22 und 24.
* Der Dependabot-Auto-Merge-Workflow wurde gehärtet: Er checkt keinen Pull-Request-Code mehr aus, läuft
  nur für Pull Requests, die wirklich von Dependabot stammen, verwendet das automatisch
  bereitgestellte `GITHUB_TOKEN` mit minimalen Rechten statt eines persönlichen Access Tokens und
  pinnt die offizielle Action `dependabot/fetch-metadata` auf eine vollständige Commit-SHA. Gemergt
  wird jetzt über GitHub-Auto-Merge, erforderliche Prüfungen müssen also zuerst bestehen. Die Policy
  wurde strenger: Produktionsabhängigkeiten nur noch bei Patch-Updates, Entwicklungsabhängigkeiten bei
  Patch- und Minor-Updates.
* Das gesamte Projekt ist jetzt frei von Typfehlern: `npm run typecheck` (`tsc --noEmit` mit `strict` und
  `checkJs`) läuft in der CI und muss grün bleiben. Alle Typen sind über JSDoc deklariert — ohne
  Unterdrückungen und ohne abgeschwächte Compiler-Optionen.
* DSS-States, die zu keinem Gerät, keiner Klemme, keinem Raum, keiner Gruppe und nicht zur Wohnung
  gehören, werden einmalig mit ihrem genauen Namen gemeldet, statt stillschweigend gar kein Objekt zu
  bekommen.
* Aktualisierung der Entwicklungsabhängigkeiten: gar keine bekannten Schwachstellen mehr. Die Funde in
  mocha und `@iobroker/testing` sind über npm-`overrides` (serialize-javascript, diff, esbuild) behoben,
  statt die Testwerkzeuge herabzustufen.

### 2.4.2 (2026-08-02)

* Kein HTTP-Keep-Alive mehr. Der DSS schließt untätige Verbindungen, was bei der nächsten Anfrage
  sporadisch zu „socket hang up" führte.
* Fehlende `role` bei den States der Binäreingänge ergänzt.
* Boolesche States werden über die vom DSS gemeldete Wertzuordnung abgebildet; die üblichen
  Aus-Begriffe (off/inactive/no/0) werden verstanden, statt jede nichtleere Zeichenkette als `true` zu
  interpretieren.
* Vom DSS gelieferte Werte werden in den für das Objekt deklarierten Typ konvertiert. Der DSS meldet
  Zahlen als Zeichenketten, was zu Meldungen wie „has to be type number but received type string"
  führte.
* Ein **Lesezugriff** wird einmal wiederholt, wenn die Verbindung ohne Antwort geschlossen wurde
  („socket hang up"). Aktionen mit Nebenwirkungen (`callScene`, `undoScene`, `event/raise`,
  `state/set`, `pushSensorValue`, Ausgangswert-Schreibvorgänge) werden nie automatisch wiederholt.
* State-Werte werden nicht mehr geschrieben, bevor die zugehörigen Objekte existieren.
* Nicht unterstützte Ausgangskanäle werden auf Debug-/Info-Ebene protokolliert statt als Warnung.
* Eigener Verbindungspool für die Event-Long-Polls, damit normale Befehle wie ein Szenenaufruf nicht
  mehr blockiert werden können.
* Ein Gerät, das einen Ausgangswert nicht liefert (z. B. eine Jalousie ohne Lamellen), wird einmalig
  gemeldet statt nach jeder Szene erneut zu warnen.
