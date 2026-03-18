import { mount } from 'svelte'
import '@xterm/xterm/css/xterm.css'
import './styles/global.css'
import App from './App.svelte'

const app = mount(App, {
  target: document.getElementById('app')!,
})

export default app
