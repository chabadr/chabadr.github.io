// Sends the PDFs of the pdfOutbox collection by e-mail (the table of הנוסע
// המתמיד that index.html's "שליחה" button queues). Kept apart from index.js so
// it can be tried without Firebase: the transporter and the documents are
// passed in.

const MAX_AGE_MS = 2 * 24 * 3600 * 1000; // sent / failed documents are cleaned up after 2 days

// One queued document -> { status: 'sent' } or { status: 'failed', error }.
async function sendQueuedPdf(data, email, transporter, from){
  if (!email) return { status: 'failed', error: 'לא הוגדרה כתובת לשליחה בעמוד הניהול' };
  if (!data.pdfBase64) return { status: 'failed', error: 'אין קובץ PDF במסמך' };
  try{
    await transporter.sendMail({
      from,
      to: email,
      subject: data.subject || 'הנוסע המתמיד',
      text: 'מצורפת טבלת הנוסע המתמיד כפי שהוצגה בעת השליחה.',
      attachments: [{
        filename: data.filename || 'table.pdf',
        content: Buffer.from(data.pdfBase64, 'base64'),
        contentType: 'application/pdf'
      }]
    });
    return { status: 'sent' };
  } catch(e){
    return { status: 'failed', error: String((e && e.message) || e) };
  }
}

module.exports = { sendQueuedPdf, MAX_AGE_MS };
