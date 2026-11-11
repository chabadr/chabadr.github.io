// Sends the PDFs of the pdfOutbox collection by e-mail (the table of הנוסע
// המתמיד that index.html's "שליחה" button queues). Kept apart from index.js so
// it can be tried without Firebase: the transporter and the documents are
// passed in.

const MAX_AGE_MS = 2 * 24 * 3600 * 1000; // sent / failed documents are cleaned up after 2 days

// A batch of queued documents (the weeks of one send, one PDF file each) ->
// ONE e-mail with all the files. Result: { status: 'sent' } or { status: 'failed', error }.
// The subject is the first document's.
async function sendQueuedBatch(docs, email, transporter, from){
  if (!email) return { status: 'failed', error: 'לא הוגדרה כתובת לשליחה בעמוד הניהול' };
  const files = docs.filter((d) => d.pdfBase64);
  if (!files.length) return { status: 'failed', error: 'אין קובץ PDF במסמך' };
  try{
    await transporter.sendMail({
      from,
      to: email,
      subject: docs[0].subject || 'הנוסע המתמיד',
      text: files.length > 1
        ? 'מצורפות טבלאות הנוסע המתמיד (קובץ לכל שבוע) כפי שהוצגו בעת השליחה.'
        : 'מצורפת טבלת הנוסע המתמיד כפי שהוצגה בעת השליחה.',
      attachments: files.map((d, i) => ({
        filename: d.filename || ('table-' + (i + 1) + '.pdf'),
        content: Buffer.from(d.pdfBase64, 'base64'),
        contentType: 'application/pdf'
      }))
    });
    return { status: 'sent' };
  } catch(e){
    return { status: 'failed', error: String((e && e.message) || e) };
  }
}

// One queued document (no batch) -> the same answer.
async function sendQueuedPdf(data, email, transporter, from){
  return sendQueuedBatch([data], email, transporter, from);
}

module.exports = { sendQueuedPdf, sendQueuedBatch, MAX_AGE_MS };
