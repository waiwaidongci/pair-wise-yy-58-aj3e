import { createApp } from 'vue';
import { createPinia } from 'pinia';
import { Quasar } from 'quasar';
import 'quasar/src/css/index.sass';
import '@quasar/extras/material-icons/material-icons.css';
import router from './router';
import App from './App.vue';
import { useLiftStore } from './store';
import './styles.css';

const app = createApp(App);
const pinia = createPinia();
app.use(pinia).use(router).use(Quasar);

// 首次进入：缺实测步骤按厂家模型回填，并按现行双基准生成净空结论
const store = useLiftStore(pinia);
store.ensureConclusions();

app.mount('#app');
