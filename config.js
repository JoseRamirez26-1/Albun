// =====================================================
//  CONFIGURACIÓN DE LA NUBE (Supabase)
//  Aquí pegas los datos de tu proyecto. Mira las instrucciones.
// =====================================================
const CONFIG_NUBE = {
  // Supabase → Project Settings → API → "Project URL"
  url: "https://bsyttuvmnhdvtfykpsop.supabase.co",

  // Supabase → Project Settings → API → "anon public" (o "Publishable key")
  clave: "sb_publishable_8u1VkG_4vs9cxNNY7CZi1g_12I44n2X",

  // El correo que creaste en Supabase para entrar (la CLAVE de 6 números es la contraseña de ese usuario)
  correo: "nosotros@album.com",

  // false = pide la clave cada vez que abren la página de nuevo
  // true  = se queda abierta en ese dispositivo hasta que pulsen "Salir"
  recordarSesion: false,

  // Peso máximo por archivo en MB (el plan gratis de Supabase permite 50)
  maxMB: 50,

  // Solo se usa si NO configuras la nube (modo de prueba, solo en tu aparato)
  claveLocal: "110226"
};
