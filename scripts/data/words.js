// 为向后兼容：若仍引入本文件，转向 CSV 加载器。
import { loadWords } from './words_loader.js';
const cachePromise = loadWords(200);
export default await cachePromise;


