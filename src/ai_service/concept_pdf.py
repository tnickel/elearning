"""ReportLab-based PDF Generator for Didactic Concepts & Framework Curriculums.

Produces an A4 document with:
- Professional corporate header with branding
- Executive summary & pedagogical rationale
- Profile metadata (Target audience, prerequisites, duration/UE, didactic methodology)
- Curricular macro-roadmap (Week table)
- Detailed module & lesson plans with operationalized learning objectives and practical exercises
- Didactic annex with evaluation and quality standards
"""

import os
from datetime import datetime
from typing import Dict, Any, List
from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
from reportlab.lib.units import cm, mm
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, KeepTogether, PageBreak, HRFlowable
)
from reportlab.pdfgen import canvas

# Palette
PRIMARY_COLOR = colors.HexColor("#0f172a")     # Deep slate
SECONDARY_COLOR = colors.HexColor("#0d9488")   # Teal
ACCENT_EMERALD = colors.HexColor("#10b981")    # Emerald
DARK_TEXT = colors.HexColor("#1e293b")         # Slate 800
MUTED_TEXT = colors.HexColor("#64748b")        # Slate 500
LIGHT_BG = colors.HexColor("#f8fafc")          # Slate 50
CARD_BORDER = colors.HexColor("#e2e8f0")       # Slate 200
BADGE_BG = colors.HexColor("#ecfdf5")          # Emerald 50
BADGE_BORDER = colors.HexColor("#a7f3d0")      # Emerald 200


class NumberedCanvas(canvas.Canvas):
    """Two-pass canvas for exact 'Seite X von Y' page numbers and running header/footer."""
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._saved_page_states = []

    def showPage(self):
        self._saved_page_states.append(dict(self.__dict__))
        self._startPage()

    def save(self):
        num_pages = len(self._saved_page_states)
        for state in self._saved_page_states:
            self.__dict__.update(state)
            self.draw_page_decorations(num_pages)
            super().showPage()
        super().save()

    def draw_page_decorations(self, page_count: int):
        self.saveState()
        self.setFont("Helvetica", 8)
        self.setFillColor(MUTED_TEXT)

        # Header (pages > 1)
        if self._pageNumber > 1:
            self.drawString(2 * cm, 28.3 * cm, "KI LEARN ENTERPRISE  •  DIDAKTISCHES RAHMENKONZEPT")
            self.setStrokeColor(CARD_BORDER)
            self.setLineWidth(0.5)
            self.line(2 * cm, 28.1 * cm, 19 * cm, 28.1 * cm)

        # Footer (all pages)
        self.setStrokeColor(CARD_BORDER)
        self.setLineWidth(0.5)
        self.line(2 * cm, 1.6 * cm, 19 * cm, 1.6 * cm)

        date_str = datetime.now().strftime("%d.%m.%Y")
        self.drawString(2 * cm, 1.2 * cm, f"Stand: {date_str}  |  Vertraulich & Zertifizierungsrelevant")
        page_text = f"Seite {self._pageNumber} von {page_count}"
        self.drawRightString(19 * cm, 1.2 * cm, page_text)
        self.restoreState()


def create_concept_pdf(concept_data: Dict[str, Any], output_path: str) -> str:
    """Generates a professional didactic concept PDF at output_path."""
    os.makedirs(os.path.dirname(os.path.abspath(output_path)), exist_ok=True)

    doc = SimpleDocTemplate(
        output_path,
        pagesize=A4,
        leftMargin=2 * cm,
        rightMargin=2 * cm,
        topMargin=2.2 * cm,
        bottomMargin=2.2 * cm,
    )

    styles = getSampleStyleSheet()

    # Custom styles
    title_style = ParagraphStyle(
        'DocTitle',
        parent=styles['Normal'],
        fontName='Helvetica-Bold',
        fontSize=22,
        leading=26,
        textColor=PRIMARY_COLOR,
        spaceAfter=4,
    )

    subtitle_style = ParagraphStyle(
        'DocSubtitle',
        parent=styles['Normal'],
        fontName='Helvetica-Bold',
        fontSize=11,
        leading=15,
        textColor=SECONDARY_COLOR,
        spaceAfter=14,
    )

    h1_style = ParagraphStyle(
        'Heading1_Custom',
        parent=styles['Normal'],
        fontName='Helvetica-Bold',
        fontSize=14,
        leading=18,
        textColor=PRIMARY_COLOR,
        spaceBefore=12,
        spaceAfter=6,
        keepWithNext=True,
    )

    h2_style = ParagraphStyle(
        'Heading2_Custom',
        parent=styles['Normal'],
        fontName='Helvetica-Bold',
        fontSize=11,
        leading=15,
        textColor=SECONDARY_COLOR,
        spaceBefore=10,
        spaceAfter=4,
        keepWithNext=True,
    )

    body_style = ParagraphStyle(
        'Body_Custom',
        parent=styles['Normal'],
        fontName='Helvetica',
        fontSize=9.5,
        leading=13.5,
        textColor=DARK_TEXT,
        spaceAfter=6,
    )

    bullet_style = ParagraphStyle(
        'Bullet_Custom',
        parent=styles['Normal'],
        fontName='Helvetica',
        fontSize=9,
        leading=13,
        textColor=DARK_TEXT,
        leftIndent=14,
        firstLineIndent=-10,
        spaceAfter=3,
    )

    meta_label = ParagraphStyle(
        'MetaLabel',
        parent=styles['Normal'],
        fontName='Helvetica-Bold',
        fontSize=9,
        leading=12,
        textColor=PRIMARY_COLOR,
    )

    meta_val = ParagraphStyle(
        'MetaVal',
        parent=styles['Normal'],
        fontName='Helvetica',
        fontSize=9,
        leading=12,
        textColor=DARK_TEXT,
    )

    story = []

    # 1. Header & Title Banner
    badge_p = Paragraph(
        "<font color='#0d9488'><b>DIDAKTISCHES RAHMENKONZEPT &amp; MODULHANDBUCH</b></font>",
        subtitle_style
    )
    story.append(badge_p)

    course_title = concept_data.get("course_title", "Didaktisches Kurskonzept")
    title_p = Paragraph(course_title, title_style)
    story.append(title_p)
    story.append(Spacer(1, 6))

    # 2. Key Facts / Metadata Box
    total_ue = concept_data.get("total_ue", 80)
    duration_desc = concept_data.get("duration_desc", f"{len(concept_data.get('modules', []))} Wochen ({total_ue} UE)")
    target_audience = concept_data.get("target_audience", "Fachkräfte, Quereinsteiger und IT-Interessierte")
    prerequisites = concept_data.get("prerequisites", "Solide Grundkenntnisse und logisches Denkvermögen")
    didactic_approach = concept_data.get("didactic_approach", "Praxisorientiertes Blended-Learning mit Hands-On Labs")

    meta_data = [
        [Paragraph("Gesamtaufwand:", meta_label), Paragraph(f"<b>{total_ue} UE</b> ({duration_desc})", meta_val),
         Paragraph("Format:", meta_label), Paragraph("Reines Rahmenkonzept (Modulplan)", meta_val)],
        [Paragraph("Zielgruppe:", meta_label), Paragraph(target_audience, meta_val),
         Paragraph("Didaktik:", meta_label), Paragraph(didactic_approach, meta_val)],
        [Paragraph("Voraussetzungen:", meta_label), Paragraph(prerequisites, meta_val),
         Paragraph("Standard:", meta_label), Paragraph("DQR / AZAV konforme Struktur", meta_val)],
    ]
    meta_table = Table(meta_data, colWidths=[3.0 * cm, 6.0 * cm, 2.5 * cm, 5.5 * cm])
    meta_table.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, -1), LIGHT_BG),
        ('BOX', (0, 0), (-1, -1), 0.75, CARD_BORDER),
        ('INNERGRID', (0, 0), (-1, -1), 0.5, CARD_BORDER),
        ('TOPPADDING', (0, 0), (-1, -1), 5),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 5),
        ('LEFTPADDING', (0, 0), (-1, -1), 6),
        ('RIGHTPADDING', (0, 0), (-1, -1), 6),
    ]))
    story.append(meta_table)
    story.append(Spacer(1, 12))

    # 3. Executive Summary / Pädagogische Leitidee
    exec_summary = concept_data.get("executive_summary", "")
    if exec_summary:
        story.append(Paragraph("1. Pädagogische Leitidee &amp; Kursziel", h1_style))
        story.append(Paragraph(exec_summary, body_style))
        story.append(Spacer(1, 8))

    # 4. Curriculare Gesamtstruktur (Wochenübersicht)
    modules = concept_data.get("modules", [])
    if modules:
        story.append(Paragraph("2. Curriculare Gesamtstruktur", h1_style))
        road_header = [
            Paragraph("<b>Woche / Modul</b>", meta_label),
            Paragraph("<b>Themenschwerpunkt &amp; Meilenstein</b>", meta_label),
            Paragraph("<b>Umfang</b>", meta_label),
            Paragraph("<b>Lektionen</b>", meta_label)
        ]
        road_rows = [road_header]
        for m in modules:
            w_num = m.get("week_number", 1)
            m_title = m.get("title", f"Modul {w_num}")
            w_goal = m.get("weekly_goal") or m.get("description") or ""
            w_ue = m.get("total_ue") or (len(m.get("lessons", [])) * 8)
            les_count = len(m.get("lessons", []))

            cell_title = f"<b>Woche {w_num}</b><br/><font color='#0d9488'>{m_title}</font>"
            road_rows.append([
                Paragraph(cell_title, meta_val),
                Paragraph(w_goal, meta_val),
                Paragraph(f"{w_ue} UE", meta_val),
                Paragraph(f"{les_count} Einheiten", meta_val)
            ])

        road_table = Table(road_rows, colWidths=[4.2 * cm, 8.8 * cm, 2.0 * cm, 2.0 * cm])
        road_table.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, 0), BADGE_BG),
            ('BOX', (0, 0), (-1, -1), 0.75, CARD_BORDER),
            ('INNERGRID', (0, 0), (-1, -1), 0.5, CARD_BORDER),
            ('TOPPADDING', (0, 0), (-1, -1), 4),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
            ('LEFTPADDING', (0, 0), (-1, -1), 5),
            ('RIGHTPADDING', (0, 0), (-1, -1), 5),
        ]))
        story.append(road_table)
        story.append(Spacer(1, 14))

    # 5. Detaillierte Modul- & Lektionsbeschreibungen
    story.append(Paragraph("3. Detaillierte Wochen- &amp; Lektionspläne", h1_style))
    story.append(Paragraph(
        "Die folgenden Abschnitte spezifizieren die Feinlernziele, methodischen Ansätze und Zeitkontingente der einzelnen Einheiten.",
        body_style
    ))
    story.append(Spacer(1, 6))

    for idx, mod in enumerate(modules):
        w_num = mod.get("week_number", idx + 1)
        m_title = mod.get("title", f"Modul {w_num}")
        w_goal = mod.get("weekly_goal", "")
        w_ue = mod.get("total_ue", 40)
        lessons = mod.get("lessons", [])

        # Module banner table
        mod_banner_data = [[
            Paragraph(f"<b>WOCHE {w_num}: {m_title.upper()}</b>", ParagraphStyle('MB', parent=styles['Normal'], fontName='Helvetica-Bold', fontSize=10, textColor=colors.white)),
            Paragraph(f"<b>{w_ue} UE</b>", ParagraphStyle('MBU', parent=styles['Normal'], fontName='Helvetica-Bold', fontSize=10, textColor=colors.white, alignment=2))
        ]]
        mod_banner = Table(mod_banner_data, colWidths=[14.5 * cm, 2.5 * cm])
        mod_banner.setStyle(TableStyle([
            ('BACKGROUND', (0, 0), (-1, -1), PRIMARY_COLOR),
            ('TOPPADDING', (0, 0), (-1, -1), 4),
            ('BOTTOMPADDING', (0, 0), (-1, -1), 4),
            ('LEFTPADDING', (0, 0), (-1, -1), 6),
            ('RIGHTPADDING', (0, 0), (-1, -1), 6),
        ]))

        mod_story = [Spacer(1, 6), mod_banner]
        if w_goal:
            goal_p = Paragraph(f"<b>Wochen-Kernziel:</b> {w_goal}", ParagraphStyle('WG', parent=body_style, textColor=SECONDARY_COLOR))
            mod_story.append(Spacer(1, 3))
            mod_story.append(goal_p)
        mod_story.append(Spacer(1, 6))

        # Lessons table / list
        for l_idx, les in enumerate(lessons):
            l_title = les.get("title", f"Lektion {l_idx + 1}")
            l_desc = les.get("description", "")
            l_ue = les.get("target_ue", 8)
            l_method = les.get("methodology", "Hands-On & Theorie")
            l_objectives = les.get("learning_objectives", [])
            l_exercise = les.get("practical_exercise", "")

            les_block = []
            les_title_p = Paragraph(f"<b>{l_idx + 1}. {l_title}</b>  <font color='#64748b'>({l_ue} UE • {l_method})</font>", h2_style)
            les_block.append(les_title_p)

            if l_desc:
                les_block.append(Paragraph(l_desc, body_style))

            if l_objectives:
                les_block.append(Paragraph("<b>Konkrete Kompetenzziele (Die Teilnehmenden können...):</b>", meta_label))
                for obj in l_objectives:
                    les_block.append(Paragraph(f"• {obj}", bullet_style))

            if l_exercise:
                ex_p = Paragraph(f"<b>Praxistransfer &amp; Labor:</b> <font color='#1e293b'>{l_exercise}</font>", bullet_style)
                les_block.append(Spacer(1, 2))
                les_block.append(ex_p)

            les_block.append(Spacer(1, 6))
            mod_story.append(KeepTogether(les_block))

        story.append(KeepTogether(mod_story))
        story.append(Spacer(1, 8))

    # 6. Didaktische Zusatzinformationen & Qualitätssicherung
    story.append(Spacer(1, 10))
    story.append(Paragraph("4. Didaktische Qualitätssicherung &amp; Praxistransfer", h1_style))

    quality_text = (
        "<b>Lernerfolgskontrolle:</b> Der didaktische Rahmen sieht eine kontinuierliche, formative "
        "Leistungsrückmeldung durch praxisnahe Code-Reviews, Meilenstein-Abgaben und simulierte "
        "Fachgespräche vor. Am Ende jeder Woche steht ein lauffähiges Teilergebnis im Mittelpunkt.<br/><br/>"
        "<b>Praxistransfer:</b> Durch den Verzicht auf passive Frontalbeschallung liegt der Schwerpunkt "
        "auf selbstgesteuertem Lernen, Pair-Programming und der Lösung realer Industrieszenarien. "
        "Dieses Konzept dient als normativer Leitfaden für die spätere modulare Ausarbeitung."
    )
    story.append(Paragraph(quality_text, body_style))

    # Build PDF
    doc.build(story, canvasmaker=NumberedCanvas)
    return output_path
