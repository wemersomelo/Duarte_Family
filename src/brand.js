'use strict';
// Marca do site num lugar só. Para trocar o nome, mude no .env (BRAND_NAME etc.) e reinicie: nada mais precisa mudar.
const brand = {
  name: process.env.BRAND_NAME || 'Dequem',
  line: process.env.BRAND_LINE || 'Genealogia',
  slogan: process.env.BRAND_SLOGAN || 'Ocê é fi dequem?',
  family: process.env.FAMILY_SUBTITLE || '' // nome sugerido; o nome de verdade é escolhido por cada família (setting "familia")
};
module.exports = brand;
