import './sim-flag'; // must stay first
import './fakecam';
import './hub';
import { createRoot } from 'react-dom/client';
import { App } from '../App';
import { setBaseStyles } from '../map/GameMap';
import { DAY, NIGHT } from './basemap';
import { Panel } from './Panel';
import { Topo } from '../ui/icons';
import '@fontsource/barlow/400.css';
import '@fontsource/barlow/500.css';
import '@fontsource/barlow/600.css';
import '@fontsource/barlow-condensed/600.css';
import '@fontsource/barlow-condensed/700.css';
import '@fontsource/barlow-condensed/800.css';
import '../styles.css';
import './demo.css';

setBaseStyles(DAY, NIGHT);

createRoot(document.getElementById('topo')!).render(<Topo className="stage-topo" />);
createRoot(document.getElementById('panel')!).render(<Panel />);
createRoot(document.getElementById('root')!).render(<App />);
