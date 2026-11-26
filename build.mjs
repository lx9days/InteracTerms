import {cp, mkdir} from 'node:fs/promises'
import path from 'node:path'
const output = 'dist'
await mkdir(output, {recursive:true})
for (const file of ['index.html','app.mjs','style.css','cases.json','catalog.json','evidence','pdfs']) {
  await cp(file,path.join(output,file),{recursive:true})
}
const pdfjs = 'node_modules/pdfjs-dist'
for (const file of ['build/pdf.mjs','build/pdf.worker.mjs','cmaps','standard_fonts','wasm','LICENSE']) {
  await cp(path.join(pdfjs,file),path.join(output,'pdfjs',path.basename(file)),{recursive:true})
}
